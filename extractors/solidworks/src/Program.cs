using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text;
using System.Threading;
using Slop.SolidWorks.Extract;
using Slop.SolidWorks.Session;
using SolidWorks.Interop.sldworks;

namespace Slop.SolidWorks
{
    /// <summary>
    /// SlopExtractor: reads SOLIDWORKS parts into design-intent IR JSON
    /// (packages/ir) for the Onshape builder (packages/onshape).
    /// </summary>
    internal static class Program
    {
        private const string Usage = @"SlopExtractor: SOLIDWORKS part -> design-intent IR (packages/ir) for the Onshape builder.

  SlopExtractor extract <part.SLDPRT>... [options]   extract parts
  SlopExtractor extract --active [options]           extract the part open in SOLIDWORKS
  SlopExtractor watch <folder|part.SLDPRT> [options] re-extract every time a part is saved
  SlopExtractor info [--pid N]                       show the SOLIDWORKS session and its open documents

Writes <name>.ir.json and <name>.extract.json (what was and was not carried) next to
the part, or into --out.

Options
  --out <dir>        output folder
  --behavior <n>     driving dimensions to perturb for Level 3 evidence (default 10 for
                     extract, 0 for watch and --active, which work on documents you may
                     have open)
  --no-evidence      skip the rollback pass (no per-feature evidence, no re-measured
                     references; much faster, but the Onshape side cannot check the build)
  --pid <n>          use the SOLIDWORKS session with this process id
  --new-instance     start a separate SOLIDWORKS in the background even if one is
                     running, so your own session is never touched
  --visible          show a SOLIDWORKS this tool starts (default: hidden)
  --keep-running     leave a SOLIDWORKS this tool started running afterwards

By default the tool attaches to the SOLIDWORKS you have open; if none is running it
starts one in the background and closes it when done.";

        [STAThread]
        private static int Main(string[] args)
        {
            Console.OutputEncoding = Encoding.UTF8;
            Thread.CurrentThread.CurrentCulture = CultureInfo.InvariantCulture;
            if (args.Length == 0 || args[0] == "-h" || args[0] == "--help")
            {
                Console.WriteLine(Usage);
                return args.Length == 0 ? 2 : 0;
            }

            Arguments a;
            try
            {
                a = Arguments.Parse(args.Skip(1).ToArray());
            }
            catch (ArgumentException e)
            {
                Console.Error.WriteLine(e.Message);
                return 2;
            }

            MessageFilter.Register();
            try
            {
                switch (args[0])
                {
                    case "extract":
                        return RunExtract(a);
                    case "watch":
                        return RunWatch(a);
                    case "info":
                        return RunInfo(a);
                    default:
                        Console.Error.WriteLine($"unknown command \"{args[0]}\"\n\n{Usage}");
                        return 2;
                }
            }
            catch (SessionException e)
            {
                Console.Error.WriteLine($"error: {e.Message}");
                return 1;
            }
            finally
            {
                MessageFilter.Revoke();
            }
        }

        private static void Log(string line) => Console.WriteLine(line);

        // --- extract ------------------------------------------------------------------

        private static int RunExtract(Arguments a)
        {
            if (!a.Active && a.Paths.Count == 0) throw new SessionException("extract: give one or more .SLDPRT files, or --active");
            var options = new ExtractOptions { Evidence = a.Evidence, BehaviorLimit = a.Behavior ?? (a.Active ? 0 : 10) };
            int failures = 0;
            using (var session = SolidWorksSession.Connect(a.Session, Log))
            {
                if (a.Active)
                {
                    var doc = session.ActiveDocument() ?? throw new SessionException("SOLIDWORKS has no active document");
                    string path = doc.GetPathName();
                    failures += ExtractOne(session, doc, string.IsNullOrEmpty(path) ? null : path, a.OutDir, options) ? 0 : 1;
                }
                foreach (var path in a.Paths.SelectMany(Expand))
                {
                    ModelDoc2 doc;
                    bool alreadyOpen;
                    try
                    {
                        doc = session.OpenPart(path, out alreadyOpen);
                    }
                    catch (SessionException e)
                    {
                        Console.Error.WriteLine($"error: {e.Message}");
                        failures++;
                        continue;
                    }
                    if (alreadyOpen && options.BehaviorLimit > 0)
                        Log($"{Path.GetFileName(path)} is open in SOLIDWORKS: its dimensions are changed and restored for behaviour evidence (use --behavior 0 to avoid)");
                    try
                    {
                        failures += ExtractOne(session, doc, path, a.OutDir, options) ? 0 : 1;
                    }
                    finally
                    {
                        if (!alreadyOpen) session.Close(doc);
                    }
                }
            }
            return failures == 0 ? 0 : 1;
        }

        private static bool ExtractOne(SolidWorksSession session, ModelDoc2 doc, string path, string outDir, ExtractOptions options)
        {
            string title = path != null ? Path.GetFileName(path) : doc.GetTitle();
            Log($"\n{title}");
            try
            {
                ExtractResult result;
                using (session.Busy())
                    result = new PartExtractor(session.App, doc, path, session.Release, session.Revision, options, Log).Run();

                string dir = outDir ?? (path != null ? Path.GetDirectoryName(path) : Directory.GetCurrentDirectory());
                Directory.CreateDirectory(dir);
                string stem = Path.Combine(dir, Path.GetFileNameWithoutExtension(title));
                var utf8 = new UTF8Encoding(false);
                File.WriteAllText(stem + ".ir.json", result.IrJson, utf8);
                File.WriteAllText(stem + ".extract.json", result.ReportJson, utf8);
                Log($"wrote {stem}.ir.json: {result.Features} features, {result.Behavior} behaviour measurements; " +
                    $"{result.Unsupported} not carried, {result.Errors} failed, {result.Warnings} warnings (see {Path.GetFileName(stem)}.extract.json)");
                return result.Errors == 0;
            }
            catch (Exception e) when (!(e is OutOfMemoryException))
            {
                Console.Error.WriteLine($"error: {title}: {e.Message}");
                Console.Error.WriteLine(e.StackTrace);
                return false;
            }
        }

        private static IEnumerable<string> Expand(string path)
        {
            if (Directory.Exists(path)) return Directory.GetFiles(path, "*.sldprt").Where(p => !Path.GetFileName(p).StartsWith("~$")).OrderBy(p => p);
            return new[] { path };
        }

        // --- watch --------------------------------------------------------------------

        /// <summary>
        /// Poll for saved parts and extract each one once its file stops
        /// changing. Polling the timestamp (rather than COM events) works the
        /// same whether the part is open in your session or not, and survives
        /// SOLIDWORKS writing the file in several steps.
        /// </summary>
        private static int RunWatch(Arguments a)
        {
            if (a.Paths.Count != 1) throw new SessionException("watch: give one folder or one .SLDPRT file");
            string target = Path.GetFullPath(a.Paths[0]);
            bool folder = Directory.Exists(target);
            if (!folder && !File.Exists(target)) throw new SessionException($"not found: {target}");
            var options = new ExtractOptions { Evidence = a.Evidence, BehaviorLimit = a.Behavior ?? 0 };
            a.Session.KeepRunning = false;

            var stop = new ManualResetEvent(false);
            Console.CancelKeyPress += (_, e) =>
            {
                e.Cancel = true;
                stop.Set();
            };

            using (var session = SolidWorksSession.Connect(a.Session, Log))
            {
                IEnumerable<string> Parts() => folder
                    ? Directory.GetFiles(target, "*.sldprt").Where(p => !Path.GetFileName(p).StartsWith("~$"))
                    : new[] { target };
                var done = Parts().ToDictionary(p => p, File.GetLastWriteTimeUtc, StringComparer.OrdinalIgnoreCase);
                var seen = new Dictionary<string, DateTime>(StringComparer.OrdinalIgnoreCase);
                Log($"watching {target} ({done.Count} part(s)); save a part in SOLIDWORKS to extract it, Ctrl+C to stop");
                while (!stop.WaitOne(TimeSpan.FromSeconds(2)))
                {
                    foreach (var path in Parts())
                    {
                        var stamp = File.GetLastWriteTimeUtc(path);
                        if (done.TryGetValue(path, out var last) && last == stamp) continue;
                        // Wait until the timestamp holds still for one poll: the save has finished.
                        if (!seen.TryGetValue(path, out var previous) || previous != stamp)
                        {
                            seen[path] = stamp;
                            continue;
                        }
                        done[path] = stamp;
                        ModelDoc2 doc;
                        bool alreadyOpen;
                        try
                        {
                            doc = session.OpenPart(path, out alreadyOpen);
                        }
                        catch (SessionException e)
                        {
                            Console.Error.WriteLine($"error: {e.Message}");
                            continue;
                        }
                        try
                        {
                            ExtractOne(session, doc, path, a.OutDir, options);
                        }
                        finally
                        {
                            if (!alreadyOpen) session.Close(doc);
                        }
                    }
                }
            }
            return 0;
        }

        // --- info ---------------------------------------------------------------------

        private static int RunInfo(Arguments a)
        {
            a.Session.KeepRunning = false;
            using (var session = SolidWorksSession.Connect(a.Session, Log))
            {
                Log($"SOLIDWORKS {session.Release} (revision {session.Revision}), pid {session.ProcessId}{(session.Started ? ", started by this tool" : "")}");
                var docs = Extract.Com.Objects(session.App.GetDocuments()).OfType<ModelDoc2>().ToList();
                Log(docs.Count == 0 ? "no open documents" : "open documents:");
                foreach (var d in docs) Log($"  {d.GetTitle()}  {d.GetPathName()}");
                if (session.ActiveDocument() is ModelDoc2 active) Log($"active: {active.GetTitle()}");
            }
            return 0;
        }

        // --- arguments ----------------------------------------------------------------

        private sealed class Arguments
        {
            public readonly List<string> Paths = new List<string>();
            public readonly SessionOptions Session = new SessionOptions();
            public string OutDir;
            public int? Behavior;
            public bool Evidence = true;
            public bool Active;

            public static Arguments Parse(string[] args)
            {
                var a = new Arguments();
                for (int i = 0; i < args.Length; i++)
                {
                    string Next() => i + 1 < args.Length ? args[++i] : throw new ArgumentException($"{args[i]} needs a value");
                    switch (args[i])
                    {
                        case "--out": a.OutDir = Path.GetFullPath(Next()); break;
                        case "--behavior": a.Behavior = int.Parse(Next(), CultureInfo.InvariantCulture); break;
                        case "--no-evidence": a.Evidence = false; break;
                        case "--active": a.Active = true; break;
                        case "--pid": a.Session.ProcessId = int.Parse(Next(), CultureInfo.InvariantCulture); break;
                        case "--new-instance": a.Session.NewInstance = true; break;
                        case "--visible": a.Session.Visible = true; break;
                        case "--keep-running": a.Session.KeepRunning = true; break;
                        default:
                            if (args[i].StartsWith("--")) throw new ArgumentException($"unknown option {args[i]}");
                            a.Paths.Add(Path.GetFullPath(args[i]));
                            break;
                    }
                }
                return a;
            }
        }
    }
}
