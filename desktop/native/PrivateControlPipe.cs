// Windows-only authenticated transport and process identity helper.
using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Pipes;
using System.Management;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;

internal static class PrivateControlPipe
{
    private const uint PIPE_ACCESS_DUPLEX = 0x00000003;
    private const uint FILE_FLAG_OVERLAPPED = 0x40000000;
    private const uint FILE_FLAG_FIRST_PIPE_INSTANCE = 0x00080000;
    private const uint PIPE_REJECT_REMOTE_CLIENTS = 0x00000008;
    private const uint SDDL_REVISION_1 = 1;
    private const uint DACL_SECURITY_INFORMATION = 0x00000004;
    private const int SE_KERNEL_OBJECT = 6;
    private const int MAX_FRAME_BYTES = 8192;
    private static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = MAX_FRAME_BYTES };
    private static readonly Regex NoncePattern = new Regex("^[A-Za-z0-9_-]{43}$", RegexOptions.CultureInvariant);
    private static readonly Regex PipePattern = new Regex("^hajimink-[0-9a-f]{32}$", RegexOptions.CultureInvariant);

    [StructLayout(LayoutKind.Sequential)]
    private struct SecurityAttributes
    {
        public int Length;
        public IntPtr Descriptor;
        [MarshalAs(UnmanagedType.Bool)] public bool InheritHandle;
    }
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool ConvertStringSecurityDescriptorToSecurityDescriptorW(string text, uint revision, out IntPtr descriptor, IntPtr length);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafePipeHandle CreateNamedPipeW(string name, uint openMode, uint pipeMode, uint maxInstances, uint outBuffer, uint inBuffer, uint timeout, ref SecurityAttributes attributes);
    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern uint GetSecurityInfo(SafePipeHandle handle, int objectType, uint securityInfo, out IntPtr owner, out IntPtr group, out IntPtr dacl, out IntPtr sacl, out IntPtr descriptor);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool ConvertSecurityDescriptorToStringSecurityDescriptorW(IntPtr descriptor, uint revision, uint securityInfo, out IntPtr text, IntPtr length);
    [DllImport("kernel32.dll")]
    private static extern IntPtr LocalFree(IntPtr value);
    [StructLayout(LayoutKind.Sequential)]
    private struct NativeFileTime { public uint Low; public uint High; }
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern SafeProcessHandle OpenProcess(uint access, bool inherit, uint processId);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool QueryFullProcessImageNameW(SafeProcessHandle process, uint flags, StringBuilder name, ref int size);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetProcessTimes(SafeProcessHandle process, out NativeFileTime creation, out NativeFileTime exit, out NativeFileTime kernel, out NativeFileTime user);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(SafeProcessHandle process, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateProcess(SafeProcessHandle process, uint exitCode);
    [DllImport("shell32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CommandLineToArgvW(string commandLine, out int argc);

    private static string B64(byte[] bytes) { return Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_'); }
    private static byte[] Decode(string text)
    {
        string value = text.Replace('-', '+').Replace('_', '/');
        value += new string('=', (4 - value.Length % 4) % 4);
        return Convert.FromBase64String(value);
    }
    private static string RandomNonce()
    {
        var bytes = new byte[32];
        using (var rng = RandomNumberGenerator.Create()) rng.GetBytes(bytes);
        return B64(bytes);
    }
    private static string Sign(byte[] secret, string data)
    {
        using (var mac = new HMACSHA256(secret)) return B64(mac.ComputeHash(Encoding.UTF8.GetBytes(data)));
    }
    private static bool Equal(string left, string right)
    {
        if (left == null || right == null || left.Length != right.Length) return false;
        int diff = 0;
        for (int i = 0; i < left.Length; i++) diff |= left[i] ^ right[i];
        return diff == 0;
    }
    private static string Field(Dictionary<string, object> value, string key)
    {
        object result;
        return value != null && value.TryGetValue(key, out result) ? result as string : null;
    }
    private static Dictionary<string, object> Parse(string text)
    {
        if (text == null || text.Length > MAX_FRAME_BYTES) throw new InvalidDataException();
        return Json.Deserialize<Dictionary<string, object>>(text);
    }
    private static string PipeDacl(SafePipeHandle handle)
    {
        IntPtr owner, group, dacl, sacl, descriptor, text;
        uint result = GetSecurityInfo(handle, SE_KERNEL_OBJECT, DACL_SECURITY_INFORMATION, out owner, out group, out dacl, out sacl, out descriptor);
        if (result != 0) throw new InvalidOperationException();
        try
        {
            if (!ConvertSecurityDescriptorToStringSecurityDescriptorW(descriptor, SDDL_REVISION_1, DACL_SECURITY_INFORMATION, out text, IntPtr.Zero)) throw new InvalidOperationException();
            try { return Marshal.PtrToStringUni(text); }
            finally { LocalFree(text); }
        }
        finally { LocalFree(descriptor); }
    }
    private static NamedPipeServerStream CreateUserPipe(string name, string sid, out string dacl)
    {
        IntPtr descriptor;
        if (!ConvertStringSecurityDescriptorToSecurityDescriptorW("D:P(A;;GA;;;" + sid + ")", SDDL_REVISION_1, out descriptor, IntPtr.Zero)) throw new InvalidOperationException();
        try
        {
            var attributes = new SecurityAttributes { Length = Marshal.SizeOf(typeof(SecurityAttributes)), Descriptor = descriptor, InheritHandle = false };
            SafePipeHandle handle = CreateNamedPipeW(@"\\.\pipe\" + name, PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED | FILE_FLAG_FIRST_PIPE_INSTANCE, PIPE_REJECT_REMOTE_CLIENTS, 1, 4096, 4096, 0, ref attributes);
            if (handle.IsInvalid) { handle.Dispose(); throw new IOException("Cannot create protected first pipe instance"); }
            try
            {
                dacl = PipeDacl(handle);
                return new NamedPipeServerStream(PipeDirection.InOut, true, false, handle);
            }
            catch { handle.Dispose(); throw; }
        }
        finally { LocalFree(descriptor); }
    }
    private static async Task<string> ReadFrame(NamedPipeServerStream pipe, CancellationToken token)
    {
        var data = new MemoryStream();
        byte[] buffer = new byte[1];
        while (data.Length <= MAX_FRAME_BYTES)
        {
            int count = await pipe.ReadAsync(buffer, 0, 1, token).ConfigureAwait(false);
            if (count == 0) throw new EndOfStreamException();
            if (buffer[0] == 10) return new UTF8Encoding(false, true).GetString(data.ToArray());
            data.WriteByte(buffer[0]);
        }
        throw new InvalidDataException();
    }
    private static async Task WriteFrame(NamedPipeServerStream pipe, object value, CancellationToken token)
    {
        byte[] bytes = Encoding.UTF8.GetBytes(Json.Serialize(value) + "\n");
        if (bytes.Length > MAX_FRAME_BYTES) throw new InvalidDataException();
        await pipe.WriteAsync(bytes, 0, bytes.Length, token).ConfigureAwait(false);
        await pipe.FlushAsync(token).ConfigureAwait(false);
    }
    private static async Task<bool> Handle(NamedPipeServerStream pipe, byte[] secret, string identityData, bool bridge)
    {
        using (var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(3)))
        {
            bool authorized = false, responseSynchronized = !bridge, completedStop = false;
            try
            {
                var hello = Parse(await ReadFrame(pipe, deadline.Token).ConfigureAwait(false));
                string clientNonce = Field(hello, "nonce");
                if (Field(hello, "type") != "hello" || clientNonce == null || !NoncePattern.IsMatch(clientNonce)) return false;
                string serverNonce = RandomNonce();
                string challengeMac = Sign(secret, "HajiMink|1|server|" + clientNonce + "|" + serverNonce + "|" + identityData);
                await WriteFrame(pipe, new { type = "challenge", nonce = serverNonce, identity = identityData, proof = challengeMac }, deadline.Token).ConfigureAwait(false);
                var command = Parse(await ReadFrame(pipe, deadline.Token).ConfigureAwait(false));
                string action = Field(command, "action");
                if (Field(command, "type") != "command" || (action != "status" && action != "stop" && action != "stop-keep-natapp" && action != "diagnose-stream" && action != "local-session" && action != "natapp-start" && action != "natapp-stop")) return false;
                string expected = Sign(secret, "HajiMink|1|client|" + clientNonce + "|" + serverNonce + "|" + action);
                if (!Equal(Field(command, "proof"), expected)) return false;
                authorized = true;
                object resultObject = new { ok = true, action = action };
                completedStop = action == "stop" || action == "stop-keep-natapp";
                if (bridge)
                {
                    string requestId = Guid.NewGuid().ToString("N");
                    Console.Out.WriteLine(Json.Serialize(new { type = "request", requestId = requestId, action = action }));
                    Console.Out.Flush();
                    var responseTask = Console.In.ReadLineAsync();
                    if (await Task.WhenAny(responseTask, Task.Delay(TimeSpan.FromSeconds(35))).ConfigureAwait(false) != responseTask) throw new IOException("Controller unavailable");
                    var response = Parse(await responseTask.ConfigureAwait(false));
                    object okValue;
                    if (Field(response, "requestId") != requestId || Field(response, "action") != action || !response.TryGetValue("ok", out okValue) || !(okValue is bool)) throw new IOException("Controller response invalid");
                    // The controller response has been consumed and matched. A
                    // disconnected desktop can no longer desynchronize stdin.
                    responseSynchronized = true;
                    resultObject = response;
                    completedStop = (action == "stop" || action == "stop-keep-natapp") && (bool)okValue;
                }
                string result = B64(Encoding.UTF8.GetBytes(Json.Serialize(resultObject)));
                string resultMac = Sign(secret, "HajiMink|1|result|" + clientNonce + "|" + serverNonce + "|" + action + "|" + result);
                // The authentication deadline does not limit a legitimate graceful stop.
                await WriteFrame(pipe, new { type = "result", data = result, proof = resultMac }, CancellationToken.None).ConfigureAwait(false);
                // Do not disconnect immediately after a write: on Windows the
                // client may not have consumed the response yet. A bounded ACK
                // lets it confirm receipt without keeping the controller alive forever.
                try
                {
                    using (var ackDeadline = new CancellationTokenSource(TimeSpan.FromSeconds(2)))
                    {
                        var ack = Parse(await ReadFrame(pipe, ackDeadline.Token).ConfigureAwait(false));
                        string ackMac = Sign(secret, "HajiMink|1|ack|" + clientNonce + "|" + serverNonce + "|" + action + "|" + result);
                        if (Field(ack, "type") != "ack" || !Equal(Field(ack, "proof"), ackMac)) throw new InvalidDataException();
                    }
                }
                catch {}
                return completedStop;
            }
            catch
            {
                // If the controller response was not consumed, another request
                // could read it as its own: fail closed. Once matched, a client
                // disconnect must not take down the entire control bridge.
                if (bridge && authorized && !responseSynchronized) throw;
                return completedStop;
            }
        }
    }
    private static async Task RunServer(Dictionary<string, object> bootstrap, bool bridge)
    {
        string name = Field(bootstrap, "pipeName");
        string secretText = Field(bootstrap, "secret");
        string identityData = Field(bootstrap, "identity");
        if (name == null || !PipePattern.IsMatch(name) || secretText == null || !NoncePattern.IsMatch(secretText) || identityData == null || identityData.Length > 4096) throw new InvalidDataException();
        byte[] secret = Decode(secretText);
        if (secret.Length != 32 || B64(secret) != secretText) throw new InvalidDataException();
        string sid = WindowsIdentity.GetCurrent().User.Value;
        string dacl;
        using (var server = CreateUserPipe(name, sid, out dacl))
        {
            SafeProcessHandle parentHandle = null;
            if (bridge)
            {
                object pidValue;
                if (!bootstrap.TryGetValue("parentPid", out pidValue)) throw new InvalidDataException();
                uint parentPid = Convert.ToUInt32(pidValue, CultureInfo.InvariantCulture);
                string expectedCreation = Field(bootstrap, "parentCreation");
                parentHandle = OpenProcess(0x00101000, false, parentPid);
                NativeFileTime creation, exit, kernel, user;
                if (parentHandle.IsInvalid || WaitForSingleObject(parentHandle, 0) != 258 || !GetProcessTimes(parentHandle, out creation, out exit, out kernel, out user) || (((ulong)creation.High << 32) | creation.Low).ToString(CultureInfo.InvariantCulture) != expectedCreation) { parentHandle.Dispose(); throw new InvalidDataException(); }
                var watchedHandle = parentHandle;
                Task.Run(() => { WaitForSingleObject(watchedHandle, 0xffffffff); try { server.Dispose(); } catch {} watchedHandle.Dispose(); });
            }
            Console.Out.WriteLine(Json.Serialize(new { type = "ready", sid = sid, dacl = dacl, remoteRejected = true }));
            Console.Out.Flush();
            while (true)
            {
                await server.WaitForConnectionAsync().ConfigureAwait(false);
                bool stop = await Handle(server, secret, identityData, bridge).ConfigureAwait(false);
                // Disconnect also resets a pipe marked broken after the client
                // vanished; IsConnected is already false in that case.
                try { server.Disconnect(); } catch {}
                if (stop) break;
            }
        }
    }
    private static void ProtectCredential(Dictionary<string, object> input, bool protect)
    {
        string context = Field(input, "context");
        string value = Field(input, "value");
        if (context == null || context.Length < 1 || context.Length > 2048 || value == null || value.Length > 4096 || !Regex.IsMatch(value, "^[A-Za-z0-9_-]+$")) throw new InvalidDataException();
        byte[] bytes = Decode(value);
        if (B64(bytes) != value || (protect && bytes.Length != 32)) throw new InvalidDataException();
        byte[] entropy;
        using (var hash = SHA256.Create()) entropy = hash.ComputeHash(Encoding.UTF8.GetBytes("HajiMink|1|" + context));
        byte[] result = null;
        try
        {
            result = protect ? ProtectedData.Protect(bytes, entropy, DataProtectionScope.CurrentUser) : ProtectedData.Unprotect(bytes, entropy, DataProtectionScope.CurrentUser);
            if (!protect && result.Length != 32) throw new InvalidDataException();
            Console.Out.WriteLine(Json.Serialize(new { type = protect ? "sealed" : "opened", value = B64(result) }));
            Console.Out.Flush();
        }
        finally
        {
            Array.Clear(bytes, 0, bytes.Length);
            Array.Clear(entropy, 0, entropy.Length);
            if (result != null) Array.Clear(result, 0, result.Length);
        }
    }
    private static bool SamePath(string a, string b)
    {
        if (String.IsNullOrEmpty(a) || String.IsNullOrEmpty(b) || !Path.IsPathRooted(a) || !Path.IsPathRooted(b)) return false;
        return String.Equals(Path.GetFullPath(a), Path.GetFullPath(b), StringComparison.OrdinalIgnoreCase);
    }
    private static bool MatchArguments(uint pid, Dictionary<string, object> input)
    {
        string kind = Field(input, "kind"), entry = Field(input, "entry"), dataDir = Field(input, "dataDir");
        if (kind == "tunnel")
        {
            string binaryPath = Field(input, "binaryPath"), tokenPath = Field(input, "tokenPath"), metricsAddress = Field(input, "metricsAddress"), protocol = Field(input, "protocol");
            if (String.IsNullOrEmpty(binaryPath) || String.IsNullOrEmpty(tokenPath) || String.IsNullOrEmpty(metricsAddress) || protocol != "http2") return false;
            string tunnelCommandLine = null;
            using (var search = new ManagementObjectSearcher("SELECT CommandLine FROM Win32_Process WHERE ProcessId=" + pid.ToString(CultureInfo.InvariantCulture)))
            using (var result = search.Get())
            {
                foreach (ManagementObject item in result) { using (item) { tunnelCommandLine = item["CommandLine"] as string; } break; }
            }
            if (String.IsNullOrEmpty(tunnelCommandLine)) return false;
            int tCount; IntPtr tArgv = CommandLineToArgvW(tunnelCommandLine, out tCount); if (tArgv == IntPtr.Zero) return false;
            try
            {
                var args = new string[tCount]; for (int i = 0; i < tCount; i++) args[i] = Marshal.PtrToStringUni(Marshal.ReadIntPtr(tArgv, i * IntPtr.Size));
                int expected = 10;
                if (tCount != expected || !SamePath(args[0], binaryPath)) return false;
                int o = 1;
                if (args[o] != "tunnel" || args[o + 1] != "--protocol" || args[o + 2] != "http2" || args[o + 3] != "--no-autoupdate" || args[o + 4] != "run" || args[o + 5] != "--metrics" || args[o + 6] != metricsAddress || args[o + 7] != "--token-file" || !SamePath(args[o + 8], tokenPath)) return false;
                for (int i = 0; i < tCount; i++) if (args[i] == "--token") return false;
                return true;
            }
            finally { LocalFree(tArgv); }
        }
        if (kind == "natapp")
        {
            string binaryPath = Field(input, "binaryPath"), configPath = Field(input, "configPath");
            if (String.IsNullOrEmpty(binaryPath) || String.IsNullOrEmpty(configPath) || !Path.IsPathRooted(binaryPath) || !Path.IsPathRooted(configPath)) return false;
            string command = null;
            using (var search = new ManagementObjectSearcher("SELECT CommandLine FROM Win32_Process WHERE ProcessId=" + pid.ToString(CultureInfo.InvariantCulture)))
            using (var result = search.Get())
            {
                foreach (ManagementObject item in result) { using (item) { command = item["CommandLine"] as string; } break; }
            }
            if (String.IsNullOrEmpty(command)) return false;
            int nCount; IntPtr nArgv = CommandLineToArgvW(command, out nCount); if (nArgv == IntPtr.Zero) return false;
            try
            {
                var args = new string[nCount]; for (int i = 0; i < nCount; i++) args[i] = Marshal.PtrToStringUni(Marshal.ReadIntPtr(nArgv, i * IntPtr.Size));
                return nCount == 3 && SamePath(args[0], binaryPath) && args[1].StartsWith("-config=", StringComparison.Ordinal) && SamePath(args[1].Substring(8), configPath) && args[2] == "-log=none";
            }
            finally { LocalFree(nArgv); }
        }
        if ((kind != "controller" && kind != "gateway") || String.IsNullOrEmpty(entry) || !Path.IsPathRooted(entry)) return false;
        string commandLine = null;
        using (var search = new ManagementObjectSearcher("SELECT CommandLine FROM Win32_Process WHERE ProcessId=" + pid.ToString(CultureInfo.InvariantCulture)))
        using (var result = search.Get())
        {
            foreach (ManagementObject item in result) { using (item) { commandLine = item["CommandLine"] as string; } break; }
        }
        if (String.IsNullOrEmpty(commandLine)) return false;
        int count; IntPtr argv = CommandLineToArgvW(commandLine, out count);
        if (argv == IntPtr.Zero) return false;
        try
        {
            var args = new string[count];
            for (int i = 0; i < count; i++) args[i] = Marshal.PtrToStringUni(Marshal.ReadIntPtr(argv, i * IntPtr.Size));
            if (count < 2 || !SamePath(args[1], entry)) return false;
            if (kind == "controller") return count == 2;
            return count == 6 && args[2] == "--config" && args[4] == "--data-dir" && SamePath(args[3], Path.Combine(dataDir, "config.json")) && SamePath(args[5], dataDir);
        }
        finally { LocalFree(argv); }
    }
    private static void InspectProcess(Dictionary<string, object> input)
    {
        object value;
        if (!input.TryGetValue("pid", out value)) throw new InvalidDataException();
        uint pid = Convert.ToUInt32(value, CultureInfo.InvariantCulture);
        if (pid == 0) throw new InvalidDataException();
        using (var handle = OpenProcess(0x00101000, false, pid))
        {
            if (handle.IsInvalid || WaitForSingleObject(handle, 0) != 258) throw new InvalidOperationException();
            var name = new StringBuilder(32768); int size = name.Capacity;
            NativeFileTime creation, exit, kernel, user;
            if (!QueryFullProcessImageNameW(handle, 0, name, ref size) || !GetProcessTimes(handle, out creation, out exit, out kernel, out user) || WaitForSingleObject(handle, 0) != 258) throw new InvalidOperationException();
            ulong ticks = ((ulong)creation.High << 32) | creation.Low;
            string kind = Field(input, "kind"), entry = Field(input, "entry"), dataDir = Field(input, "dataDir");
            bool matched = kind == null || MatchArguments(pid, input);
            if (WaitForSingleObject(handle, 0) != 258) throw new InvalidOperationException();
            Console.Out.WriteLine(Json.Serialize(new { type = "process", pid = pid, image = name.ToString(), creation = ticks.ToString(CultureInfo.InvariantCulture), argsMatched = matched }));
            Console.Out.Flush();
        }
    }
    // Returns whether the recorded process instance is gone. Access failures are
    // deliberately errors, never proof that a process has exited.
    private static void CheckOriginalProcess(Dictionary<string, object> input)
    {
        object value;
        if (!input.TryGetValue("pid", out value)) throw new InvalidDataException();
        uint pid = Convert.ToUInt32(value, CultureInfo.InvariantCulture);
        string expectedCreation = Field(input, "creation");
        if (pid == 0 || expectedCreation == null || !Regex.IsMatch(expectedCreation, "^[0-9]{15,22}$")) throw new InvalidDataException();
        bool gone;
        using (var handle = OpenProcess(0x00101000, false, pid))
        {
            if (handle.IsInvalid)
            {
                int error = Marshal.GetLastWin32Error();
                if (error != 87) throw new InvalidOperationException();
                gone = true;
            }
            else
            {
                NativeFileTime creation, exit, kernel, user;
                if (!GetProcessTimes(handle, out creation, out exit, out kernel, out user)) throw new InvalidOperationException();
                ulong ticks = ((ulong)creation.High << 32) | creation.Low;
                if (ticks.ToString(CultureInfo.InvariantCulture) != expectedCreation) gone = true;
                else
                {
                    uint wait = WaitForSingleObject(handle, 0);
                    if (wait != 0 && wait != 258) throw new InvalidOperationException();
                    gone = wait == 0;
                }
            }
        }
        Console.Out.WriteLine(Json.Serialize(new { type = "process-instance-check", pid = pid, gone = gone })); Console.Out.Flush();
    }
    private static void StopOwnedProcess(Dictionary<string, object> input)
    {
        object value;
        if (!input.TryGetValue("pid", out value)) throw new InvalidDataException();
        uint pid = Convert.ToUInt32(value, CultureInfo.InvariantCulture);
        string expectedImage = Field(input, "binaryPath"), expectedCreation = Field(input, "creation");
        string kind = Field(input, "kind");
        if (pid == 0 || (kind != "tunnel" && kind != "natapp") || String.IsNullOrEmpty(expectedCreation)) throw new InvalidDataException();
        using (var handle = OpenProcess(0x00101001, false, pid))
        {
            if (handle.IsInvalid || WaitForSingleObject(handle, 0) != 258) throw new InvalidOperationException();
            var name = new StringBuilder(32768); int size = name.Capacity;
            NativeFileTime creation, exit, kernel, user;
            if (!QueryFullProcessImageNameW(handle, 0, name, ref size) || !GetProcessTimes(handle, out creation, out exit, out kernel, out user)) throw new InvalidOperationException();
            ulong ticks = ((ulong)creation.High << 32) | creation.Low;
            if (!SamePath(name.ToString(), expectedImage) || ticks.ToString(CultureInfo.InvariantCulture) != expectedCreation || !MatchArguments(pid, input) || WaitForSingleObject(handle, 0) != 258) throw new InvalidOperationException();
            if (!TerminateProcess(handle, 0) || WaitForSingleObject(handle, 10000) != 0) throw new InvalidOperationException();
            Console.Out.WriteLine(Json.Serialize(new { type = "stopped", pid = pid })); Console.Out.Flush();
        }
    }
    private static void CountNatappProcesses()
    {
        int count = 0;
        using (var search = new ManagementObjectSearcher("SELECT ProcessId FROM Win32_Process WHERE Name='natapp.exe'"))
        using (var result = search.Get())
            foreach (ManagementObject item in result) { using (item) { count++; } }
        Console.Out.WriteLine(Json.Serialize(new { type = "natapp-process-count", count = count })); Console.Out.Flush();
    }
    public static int Main()
    {
        try
        {
            Console.InputEncoding = new UTF8Encoding(false, true);
            Console.OutputEncoding = new UTF8Encoding(false, true);
            var bootstrap = Parse(Console.In.ReadLine());
            string mode = Field(bootstrap, "mode");
            if (mode == "seal") ProtectCredential(bootstrap, true);
            else if (mode == "open") ProtectCredential(bootstrap, false);
            else if (mode == "inspect") InspectProcess(bootstrap);
            else if (mode == "count-natapp") CountNatappProcesses();
            else if (mode == "check-original-process") CheckOriginalProcess(bootstrap);
            else if (mode == "stop-owned") StopOwnedProcess(bootstrap);
            else if (mode == "bridge") RunServer(bootstrap, true).GetAwaiter().GetResult();
            else if (mode == null || mode == "server") RunServer(bootstrap, false).GetAwaiter().GetResult();
            else throw new InvalidDataException();
            return 0;
        }
        catch { try { Console.Error.WriteLine("Private control transport failed"); } catch {} return 1; }
    }
}
