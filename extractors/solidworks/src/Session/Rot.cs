using System;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
using SolidWorks.Interop.sldworks;

namespace Slop.SolidWorks.Session
{
    /// <summary>
    /// Finds a specific SOLIDWORKS process in the Running Object Table. Each
    /// session registers itself as "SolidWorks_PID_&lt;pid&gt;" once started,
    /// which is the only reliable way to pick one session when several run,
    /// or to talk to an instance this tool launched itself (CodeStack,
    /// "Create C# stand-alone application for SOLIDWORKS API automation").
    /// Both processes must run at the same privilege level.
    /// </summary>
    internal static class Rot
    {
        public static SldWorks Find(int processId)
        {
            string target = "SolidWorks_PID_" + processId;
            IBindCtx ctx = null;
            IRunningObjectTable rot = null;
            IEnumMoniker monikers = null;
            try
            {
                if (CreateBindCtx(0, out ctx) != 0) return null;
                ctx.GetRunningObjectTable(out rot);
                rot.EnumRunning(out monikers);
                var one = new IMoniker[1];
                while (monikers.Next(1, one, IntPtr.Zero) == 0)
                {
                    var moniker = one[0];
                    try
                    {
                        string name;
                        try
                        {
                            moniker.GetDisplayName(ctx, null, out name);
                        }
                        catch (COMException)
                        {
                            continue;
                        }
                        catch (UnauthorizedAccessException)
                        {
                            continue;
                        }
                        // Item monikers display as "!name".
                        if (!string.Equals(name?.TrimStart('!'), target, StringComparison.OrdinalIgnoreCase)) continue;
                        if (rot.GetObject(moniker, out object app) == 0) return app as SldWorks;
                    }
                    finally
                    {
                        Marshal.ReleaseComObject(moniker);
                    }
                }
                return null;
            }
            finally
            {
                if (monikers != null) Marshal.ReleaseComObject(monikers);
                if (rot != null) Marshal.ReleaseComObject(rot);
                if (ctx != null) Marshal.ReleaseComObject(ctx);
            }
        }

        [DllImport("ole32.dll")]
        private static extern int CreateBindCtx(uint reserved, out IBindCtx ppbc);
    }
}
