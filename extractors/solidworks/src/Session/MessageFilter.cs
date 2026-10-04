using System;
using System.Runtime.InteropServices;

namespace Slop.SolidWorks.Session
{
    /// <summary>
    /// OLE message filter for out-of-process automation. While SOLIDWORKS is
    /// busy (rebuilding, loading) it rejects incoming COM calls with
    /// RPC_E_CALL_REJECTED; without a filter that surfaces as a random
    /// COMException. With it, rejected calls are retried for up to a minute.
    /// Only works on an STA thread, which is why Main is [STAThread].
    /// </summary>
    internal sealed class MessageFilter : IOleMessageFilter
    {
        private const int SERVERCALL_ISHANDLED = 0;
        private const int SERVERCALL_RETRYLATER = 2;
        private const int PENDINGMSG_WAITDEFPROCESS = 2;
        private const int RetryForMs = 60_000;
        private const int RetryEveryMs = 250;

        public static void Register() => CoRegisterMessageFilter(new MessageFilter(), out _);

        public static void Revoke() => CoRegisterMessageFilter(null, out _);

        int IOleMessageFilter.HandleInComingCall(int dwCallType, IntPtr hTaskCaller, int dwTickCount, IntPtr lpInterfaceInfo) => SERVERCALL_ISHANDLED;

        int IOleMessageFilter.RetryRejectedCall(IntPtr hTaskCallee, int dwTickCount, int dwRejectType) =>
            dwRejectType == SERVERCALL_RETRYLATER && dwTickCount < RetryForMs ? RetryEveryMs : -1;

        int IOleMessageFilter.MessagePending(IntPtr hTaskCallee, int dwTickCount, int dwPendingType) => PENDINGMSG_WAITDEFPROCESS;

        [DllImport("ole32.dll")]
        private static extern int CoRegisterMessageFilter(IOleMessageFilter newFilter, out IOleMessageFilter oldFilter);
    }

    [ComImport, Guid("00000016-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IOleMessageFilter
    {
        [PreserveSig]
        int HandleInComingCall(int dwCallType, IntPtr hTaskCaller, int dwTickCount, IntPtr lpInterfaceInfo);

        [PreserveSig]
        int RetryRejectedCall(IntPtr hTaskCallee, int dwTickCount, int dwRejectType);

        [PreserveSig]
        int MessagePending(IntPtr hTaskCallee, int dwTickCount, int dwPendingType);
    }
}
