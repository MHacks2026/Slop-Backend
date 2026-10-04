using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Threading;
using Microsoft.Win32;
using SolidWorks.Interop.sldworks;
using SolidWorks.Interop.swconst;

namespace Slop.SolidWorks.Session
{
    public sealed class SessionOptions
    {
        /// <summary>Attach to this SOLIDWORKS process.</summary>
        public int? ProcessId { get; set; }
        /// <summary>Start a dedicated background instance even when one is already running.</summary>
        public bool NewInstance { get; set; }
        /// <summary>Show an instance this tool starts. By default it runs in the background, invisible.</summary>
        public bool Visible { get; set; }
        /// <summary>Leave an instance this tool started running on exit.</summary>
        public bool KeepRunning { get; set; }
        public TimeSpan StartTimeout { get; set; } = TimeSpan.FromMinutes(3);
    }

    public sealed class SessionException : Exception
    {
        public SessionException(string message) : base(message) { }
    }

    /// <summary>
    /// A connection to a SOLIDWORKS process (architecture doc §3, "Deployment
    /// and licensing"): out-of-process automation of the user's own licensed
    /// seat. Either attaches to the session the user already has open, or
    /// starts one that runs in the background with no window, and shuts it
    /// down again on dispose.
    /// </summary>
    public sealed class SolidWorksSession : IDisposable
    {
        private readonly Action<string> log;
        private readonly bool keepRunning;
        private bool disposed;

        public SldWorks App { get; }
        /// <summary>True when this tool started the process (and so owns its lifetime).</summary>
        public bool Started { get; }
        public bool Visible { get; }
        public int ProcessId { get; }
        /// <summary>RevisionNumber(), e.g. "32.1.0".</summary>
        public string Revision { get; }
        /// <summary>Marketing release derived from the revision: "2024".</summary>
        public string Release { get; }

        private SolidWorksSession(SldWorks app, bool started, bool visible, bool keepRunning, Action<string> log)
        {
            App = app;
            Started = started;
            Visible = visible;
            this.keepRunning = keepRunning;
            this.log = log ?? (_ => { });
            Revision = SafeGet(() => app.RevisionNumber(), "unknown");
            ProcessId = SafeGet(() => app.GetProcessID(), 0);
            var major = Revision.Split('.')[0];
            Release = int.TryParse(major, out int m) && m > 0 ? (1992 + m).ToString() : Revision;
        }

        public static SolidWorksSession Connect(SessionOptions options, Action<string> log)
        {
            log = log ?? (_ => { });
            if (options.ProcessId.HasValue)
            {
                var app = Rot.Find(options.ProcessId.Value)
                    ?? throw new SessionException($"no SOLIDWORKS session with process id {options.ProcessId} in the Running Object Table (still starting up, or running as a different user or elevation?)");
                log($"attached to SOLIDWORKS (pid {options.ProcessId})");
                return new SolidWorksSession(app, false, true, false, log);
            }

            var running = Process.GetProcessesByName("SLDWORKS");
            if (!options.NewInstance && running.Length > 0)
            {
                foreach (var p in running)
                {
                    var app = Rot.Find(p.Id);
                    if (app == null) continue;
                    log($"attached to the running SOLIDWORKS (pid {p.Id})");
                    return new SolidWorksSession(app, false, true, false, log);
                }
                try
                {
                    var app = (SldWorks)Marshal.GetActiveObject("SldWorks.Application");
                    log("attached to the running SOLIDWORKS");
                    return new SolidWorksSession(app, false, true, false, log);
                }
                catch (COMException)
                {
                    throw new SessionException("SOLIDWORKS is running but did not answer over COM. If it is still starting, wait; if it runs as administrator, run this tool the same way.");
                }
            }

            return Launch(options, running.Length > 0, log);
        }

        private static SolidWorksSession Launch(SessionOptions options, bool othersRunning, Action<string> log)
        {
            SldWorks app;
            if (!othersRunning)
            {
                // COM activation starts a fresh, invisible instance with no add-ins loaded.
                log("starting SOLIDWORKS in the background ...");
                var type = Type.GetTypeFromProgID("SldWorks.Application")
                    ?? throw new SessionException("SOLIDWORKS is not installed on this machine (no SldWorks.Application COM class).");
                app = (SldWorks)Activator.CreateInstance(type);
            }
            else
            {
                // With a session already running, COM activation would return that session,
                // so start the executable and find the new process by its id.
                string exe = ExecutablePath();
                log($"starting a separate background SOLIDWORKS: {exe}");
                var process = Process.Start(new ProcessStartInfo(exe) { UseShellExecute = false });
                app = WaitForRot(process, options.StartTimeout);
            }

            WaitForStartup(app, options.StartTimeout, log);
            // Visible=false keeps the window hidden. UserControlBackground is not set on purpose:
            // it keeps SOLIDWORKS alive after its controller exits, so a crash here would leave an
            // invisible session holding a license.
            app.Visible = options.Visible;
            var session = new SolidWorksSession(app, true, options.Visible, options.KeepRunning, log);
            log($"SOLIDWORKS {session.Release} ({session.Revision}) ready, pid {session.ProcessId}");
            return session;
        }

        private static SldWorks WaitForRot(Process process, TimeSpan timeout)
        {
            var clock = Stopwatch.StartNew();
            while (clock.Elapsed < timeout)
            {
                if (process.HasExited) throw new SessionException($"SOLIDWORKS exited during startup (code {process.ExitCode})");
                var app = Rot.Find(process.Id);
                if (app != null) return app;
                Thread.Sleep(1000);
            }
            throw new SessionException($"SOLIDWORKS (pid {process.Id}) did not register in the Running Object Table within {timeout.TotalSeconds:0} s");
        }

        private static void WaitForStartup(SldWorks app, TimeSpan timeout, Action<string> log)
        {
            var clock = Stopwatch.StartNew();
            while (clock.Elapsed < timeout)
            {
                try
                {
                    if (app.StartupProcessCompleted) return;
                }
                catch (COMException)
                {
                    return; // releases without the property: nothing to wait for
                }
                Thread.Sleep(500);
            }
            log("warning: SOLIDWORKS did not report startup complete; continuing");
        }

        /// <summary>SLDWORKS.exe of the running session, else the COM server's registered path.</summary>
        private static string ExecutablePath()
        {
            foreach (var p in Process.GetProcessesByName("SLDWORKS"))
            {
                try
                {
                    var path = p.MainModule?.FileName;
                    if (!string.IsNullOrEmpty(path) && File.Exists(path)) return path;
                }
                catch (Exception)
                {
                    // access denied to another user's process: try the registry
                }
            }
            var type = Type.GetTypeFromProgID("SldWorks.Application")
                ?? throw new SessionException("SOLIDWORKS is not installed on this machine (no SldWorks.Application COM class).");
            using (var key = Registry.ClassesRoot.OpenSubKey($@"CLSID\{{{type.GUID}}}\LocalServer32"))
            {
                var raw = (key?.GetValue("") as string ?? "").Trim();
                string path = raw.StartsWith("\"") ? raw.Substring(1, Math.Max(0, raw.IndexOf('"', 1) - 1)) : raw.Split(new[] { " /", " -" }, StringSplitOptions.None)[0];
                if (File.Exists(path)) return path;
            }
            throw new SessionException("cannot find SLDWORKS.exe to start a separate instance; start SOLIDWORKS yourself and run without --new-instance");
        }

        /// <summary>
        /// Open a part read-only, so nothing this tool does in memory (rollback,
        /// dimension changes) can be saved over the user's file.
        /// <paramref name="alreadyOpen"/> is true when the session had it open,
        /// in which case the caller must not close it.
        /// </summary>
        public ModelDoc2 OpenPart(string path, out bool alreadyOpen)
        {
            path = Path.GetFullPath(path);
            if (!File.Exists(path)) throw new SessionException($"file not found: {path}");

            if (App.GetOpenDocumentByName(path) is ModelDoc2 open)
            {
                alreadyOpen = true;
                return open;
            }
            alreadyOpen = false;

            bool hide = Started && !Visible;
            int part = (int)swDocumentTypes_e.swDocPART;
            if (hide) App.DocumentVisible(false, part);
            try
            {
                int flags = (int)swOpenDocOptions_e.swOpenDocOptions_Silent | (int)swOpenDocOptions_e.swOpenDocOptions_ReadOnly;
                int errors = 0, warnings = 0;
                var doc = App.OpenDoc6(path, part, flags, "", ref errors, ref warnings);
                if (doc == null) throw new SessionException($"SOLIDWORKS could not open {path}: {DescribeFlags<swFileLoadError_e>(errors)}");
                if (warnings != 0) log($"open warnings for {Path.GetFileName(path)}: {DescribeFlags<swFileLoadWarning_e>(warnings)}");
                return doc;
            }
            finally
            {
                if (hide) App.DocumentVisible(true, part);
            }
        }

        public ModelDoc2 ActiveDocument() => App.ActiveDoc as ModelDoc2;

        public void Close(ModelDoc2 doc)
        {
            try
            {
                App.CloseDoc(doc.GetTitle());
            }
            catch (COMException e)
            {
                log($"warning: could not close {doc.GetTitle()}: {e.Message}");
            }
        }

        /// <summary>
        /// Mark a command in progress for the duration: SOLIDWORKS then skips UI
        /// updates between API calls, which makes out-of-process automation
        /// several times faster.
        /// </summary>
        public IDisposable Busy()
        {
            bool before = SafeGet(() => App.CommandInProgress, false);
            SafeDo(() => App.CommandInProgress = true);
            return new Restore(() => SafeDo(() => App.CommandInProgress = before));
        }

        public void Dispose()
        {
            if (disposed) return;
            disposed = true;
            if (Started && !keepRunning)
            {
                log("closing the background SOLIDWORKS");
                SafeDo(() => App.ExitApp());
            }
        }

        private static string DescribeFlags<TEnum>(int bits) where TEnum : struct, Enum
        {
            var names = Enum.GetValues(typeof(TEnum)).Cast<TEnum>()
                .Where(v => (Convert.ToInt32(v) & bits) != 0)
                .Select(v => v.ToString());
            var text = string.Join(", ", names);
            return text.Length > 0 ? text : $"code {bits}";
        }

        private static T SafeGet<T>(Func<T> get, T fallback)
        {
            try
            {
                return get();
            }
            catch (Exception)
            {
                return fallback;
            }
        }

        private static void SafeDo(Action action)
        {
            try
            {
                action();
            }
            catch (Exception)
            {
                // best effort
            }
        }

        private sealed class Restore : IDisposable
        {
            private Action action;

            public Restore(Action action) => this.action = action;

            public void Dispose()
            {
                action?.Invoke();
                action = null;
            }
        }
    }
}
