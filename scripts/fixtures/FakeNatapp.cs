using System;
using System.IO;
using System.Threading;
internal static class FakeNatapp {
    public static int Main(string[] args) {
        if (args.Length != 2 || !args[0].StartsWith("-config=", StringComparison.Ordinal) || args[1] != "-log=none") return 2;
        if (!File.Exists(args[0].Substring(8))) return 3;
        Thread.Sleep(Timeout.Infinite); return 0;
    }
}
