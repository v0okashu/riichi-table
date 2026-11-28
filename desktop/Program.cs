using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using System.Web.Script.Serialization;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

internal static class Program
{
    internal const string Title = "汪汪队 · 立直对局室";
    internal static readonly string DataDirectory = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "WangWangRiichi");
    private const string PackageResource = "WangWangRiichi.Game.zip";
    private const string ServerResource = "WangWangRiichi.ServerUrl";

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr LoadLibrary(string path);

    [STAThread]
    private static int Main()
    {
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);

        try
        {
            Uri serverAddress = ReadServerAddress();
            string runtime = ExtractGame();
            AppDomain.CurrentDomain.AssemblyResolve += (sender, args) =>
            {
                string name = new AssemblyName(args.Name).Name;
                if (name != "Microsoft.Web.WebView2.Core" && name != "Microsoft.Web.WebView2.WinForms")
                    return null;
                return Assembly.LoadFrom(Path.Combine(runtime, name + ".dll"));
            };
            if (LoadLibrary(Path.Combine(runtime, "WebView2Loader.dll")) == IntPtr.Zero)
                throw new Win32Exception(Marshal.GetLastWin32Error(), "无法加载 WebView2 组件。");

            ShowGame(runtime, serverAddress);
            return 0;
        }
        catch (Exception error)
        {
            MessageBox.Show(error.Message, Title, MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
    }

    private static Uri ReadServerAddress()
    {
        using (Stream source = Assembly.GetExecutingAssembly().GetManifestResourceStream(ServerResource))
        {
            if (source == null) return null;
            using (var reader = new StreamReader(source))
            {
                Uri address;
                if (!Uri.TryCreate(reader.ReadToEnd().Trim(), UriKind.Absolute, out address)
                    || (address.Scheme != Uri.UriSchemeHttps &&
                        (address.Scheme != Uri.UriSchemeHttp || !address.IsLoopback))
                    || !String.IsNullOrEmpty(address.UserInfo) || address.AbsolutePath != "/"
                    || !String.IsNullOrEmpty(address.Query) || !String.IsNullOrEmpty(address.Fragment))
                    throw new InvalidOperationException("联机版服务器地址无效，请重新下载程序。");
                return address;
            }
        }
    }

    private static string ExtractGame()
    {
        string cache = Path.Combine(DataDirectory, "desktop-runtime");
        Directory.CreateDirectory(cache);
        using (Stream package = Assembly.GetExecutingAssembly().GetManifestResourceStream(PackageResource))
        using (SHA256 sha = SHA256.Create())
        {
            if (package == null) throw new InvalidOperationException("游戏文件缺失，请重新下载程序。");
            string version = BitConverter.ToString(sha.ComputeHash(package)).Replace("-", "");
            string destination = Path.Combine(cache, version);
            using (var gate = new Mutex(false, @"Local\WangWangRiichi." + version))
            {
                try { gate.WaitOne(); }
                catch (AbandonedMutexException) { }
                try
                {
                    if (!Directory.Exists(destination))
                    {
                        string staging = Path.Combine(cache, "extract-" + Guid.NewGuid().ToString("N"));
                        Directory.CreateDirectory(staging);
                        package.Position = 0;
                        using (var zip = new ZipArchive(package, ZipArchiveMode.Read, true))
                            zip.ExtractToDirectory(staging);
                        Directory.Move(staging, destination);
                    }
                    return destination;
                }
                finally { gate.ReleaseMutex(); }
            }
        }
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    private static void ShowGame(string runtime, Uri serverAddress)
    {
        using (Stream iconData = typeof(Program).Assembly.GetManifestResourceStream("WangWangRiichi.App.ico"))
        using (var icon = new Icon(iconData))
        using (var window = new GameWindow(runtime, serverAddress) { Icon = icon })
            Application.Run(window);
    }
}

internal sealed class GameWindow : Form
{
    private readonly string runtime;
    private readonly Uri serverAddress;
    private readonly Panel surface;
    private readonly Label status;
    private readonly LinkLabel back;
    private readonly System.Windows.Forms.Timer reconnect = new System.Windows.Forms.Timer { Interval = 3000 };
    private readonly string desktopControl = Guid.NewGuid().ToString("N");
    private readonly JavaScriptSerializer json = new JavaScriptSerializer { MaxJsonLength = 4096 };
    private readonly JavaScriptSerializer archiveJson = new JavaScriptSerializer { MaxJsonLength = 8 * 1024 * 1024 };
    private readonly SemaphoreSlim groupSync = new SemaphoreSlim(1, 1);
    private WebView2 view;
    private Process server;
    private FileStream profileLock;
    private Uri homeAddress;
    private Uri currentAddress;
    private IPAddress groupAddress;

    internal GameWindow(string runtime, Uri serverAddress)
    {
        this.runtime = runtime;
        this.serverAddress = serverAddress;
        Text = Program.Title;
        StartPosition = FormStartPosition.CenterScreen;
        ClientSize = new Size(1170, 835);
        MinimumSize = new Size(620, 520);
        BackColor = Color.FromArgb(16, 40, 38);
        var layout = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 1, RowCount = 2 };
        layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        layout.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        Controls.Add(layout);
        surface = new Panel { Dock = DockStyle.Fill, Margin = Padding.Empty };
        layout.Controls.Add(surface, 0, 1);
        status = new Label
        {
            Dock = DockStyle.Fill, ForeColor = Color.FromArgb(245, 240, 220),
            TextAlign = ContentAlignment.MiddleCenter, Text = "正在打开登录界面…",
            Font = new Font("Microsoft YaHei UI", 11)
        };
        surface.Controls.Add(status);
        back = new LinkLabel
        {
            Text = "返回本机大厅", AutoSize = true, LinkColor = Color.FromArgb(238, 219, 165),
            VisitedLinkColor = Color.FromArgb(238, 219, 165), Margin = new Padding(12, 6, 0, 6),
            Font = new Font("Microsoft YaHei UI", 9), Visible = false
        };
        back.LinkClicked += async (sender, args) =>
        {
            var room = ReadRoom();
            if (room != null && Origin(room) == Origin(currentAddress))
            {
                try { await SyncGroup(room, room.Query.Substring(6)); }
                catch { }
                if (IsDisposed) return;
            }
            try { File.Delete(RoomFile); }
            catch (IOException) { }
            Navigate(homeAddress);
        };
        reconnect.Tick += (sender, args) => Navigate(currentAddress);
        layout.Controls.Add(back, 0, 0);
    }

    protected override async void OnShown(EventArgs args)
    {
        base.OnShown(args);
        try
        {
            CoreWebView2Environment.GetAvailableBrowserVersionString();
            if (serverAddress == null) LockLocalProfile();
            homeAddress = serverAddress ?? await StartServer();
            if (IsDisposed) return;

            view = new WebView2 { Dock = DockStyle.Fill, Visible = false, DefaultBackgroundColor = BackColor };
            surface.Controls.Add(view);
            string browserData = Path.Combine(Program.DataDirectory,
                serverAddress == null ? "desktop-network-browser" : "desktop-online-browser");
            var environment = await CoreWebView2Environment.CreateAsync(null, browserData);
            if (IsDisposed) return;
            await view.EnsureCoreWebView2Async(environment);
            if (IsDisposed) return;

            var web = view.CoreWebView2;
            web.Settings.AreDevToolsEnabled = false;
            web.Settings.AreDefaultContextMenusEnabled = false;
            web.Settings.IsPasswordAutosaveEnabled = false;
            await web.AddScriptToExecuteOnDocumentCreatedAsync(
                "if(window===window.top){const trusted=location.origin===" + json.Serialize(Origin(homeAddress)) +
                ";const lan=" + (serverAddress == null ? "true" : "false") +
                ";window.riichiDesktop={remember:trusted,network:trusted&&lan,group:!trusted&&lan};}");
            if (IsDisposed) return;

            web.NavigationStarting += (sender, navigation) =>
            {
                Uri target;
                navigation.Cancel = !Uri.TryCreate(navigation.Uri, UriKind.Absolute, out target)
                    || Origin(target) != Origin(currentAddress);
            };
            web.NewWindowRequested += (sender, navigation) =>
            {
                navigation.Handled = true;
                Uri target;
                if (navigation.IsUserInitiated && Uri.TryCreate(navigation.Uri, UriKind.Absolute, out target)
                    && target.Scheme == Uri.UriSchemeHttps && target.Host == "m-league.jp")
                {
                    try { Process.Start(new ProcessStartInfo(target.AbsoluteUri) { UseShellExecute = true }); }
                    catch (Win32Exception) { }
                }
            };
            web.NavigationCompleted += (sender, navigation) =>
            {
                if (navigation.WebErrorStatus == CoreWebView2WebErrorStatus.OperationCanceled) return;
                bool opened = navigation.IsSuccess && navigation.HttpStatusCode < 400;
                if (!opened)
                {
                    if (back.Visible && ReadRoom() != null)
                    {
                        status.Text = "正在等待房主恢复牌桌…";
                        reconnect.Start();
                    }
                    else status.Text = "无法打开牌桌 " + currentAddress.Authority + "。";
                }
                view.Visible = opened;
                status.Visible = !opened;
                if (opened) view.BringToFront();
            };
            web.WebMessageReceived += ReceiveMessage;
            string query = serverAddress != null ? "login=1" : ReadRoom() == null ? "startup=1" : "startup=1&resumeGroup=1";
            Navigate(new UriBuilder(homeAddress) { Query = query }.Uri);
        }
        catch (WebView2RuntimeNotFoundException)
        {
            if (!IsDisposed) status.Text = "请安装 Microsoft Edge WebView2 Runtime，再重新打开汪汪队。";
            StopServer();
        }
        catch (Exception error)
        {
            if (!IsDisposed) status.Text = error.Message;
            StopServer();
        }
    }

    private static string Origin(Uri address)
    {
        return address.GetLeftPart(UriPartial.Authority);
    }

    private void Navigate(Uri address)
    {
        reconnect.Stop();
        currentAddress = address;
        back.Visible = Origin(address) != Origin(homeAddress);
        status.Text = "正在连接牌桌…";
        status.Visible = true;
        view.Visible = false;
        status.BringToFront();
        view.CoreWebView2.Navigate(address.AbsoluteUri);
    }

    private async void ReceiveMessage(object sender, CoreWebView2WebMessageReceivedEventArgs args)
    {
        Uri source;
        if (!Uri.TryCreate(args.Source, UriKind.Absolute, out source) || Origin(source) != Origin(currentAddress)) return;
        DesktopMessage message;
        try { message = json.Deserialize<DesktopMessage>(args.WebMessageAsJson); }
        catch (ArgumentException) { return; }
        catch (InvalidOperationException) { return; }
        if (message == null || message.Id < 1) return;
        bool trusted = Origin(source) == Origin(homeAddress);
        object value = null;
        string error = null;
        Uri destination = null;
        try
        {
            switch (message.Action)
            {
                case "copy":
                    if (String.IsNullOrEmpty(message.Text) || message.Text.Length > 240)
                        throw new InvalidOperationException("房间号不可用。");
                    Uri copied;
                    bool sameOrigin = Uri.TryCreate(message.Text, UriKind.Absolute, out copied) && Origin(copied) == Origin(source);
                    if (!sameOrigin && !Regex.IsMatch(message.Text, @"\A[0-9A-Z]{3}(?:-[0-9A-Z]{3}){2}\z"))
                        throw new InvalidOperationException("房间号不可用。");
                    Clipboard.SetText(message.Text);
                    break;
                case "readLogin":
                    if (trusted) value = ReadLogin();
                    break;
                case "saveLogin":
                    if (trusted) SaveLogin(message.Login);
                    break;
                case "rememberRoom":
                    if (!trusted && serverAddress == null) SaveRoom(source, message.Text);
                    break;
                case "forgetRoom":
                    Uri room = ReadRoom();
                    if (!trusted && room != null && Origin(room) == Origin(source)) File.Delete(RoomFile);
                    break;
                case "syncGroup":
                    if (trusted || serverAddress != null) return;
                    if (!Regex.IsMatch(message.Text ?? "", @"\A[0-9]{6}\z")) break;
                    value = await SyncGroup(source, message.Text);
                    break;
                case "localLeaderboard":
                    if (trusted || serverAddress != null) return;
                    using (var client = NewLanClient())
                        value = await PostLanApi(client, homeAddress, new { op = "leaderboard" }, await SessionCookie(homeAddress), large: true);
                    break;
                case "host":
                    if (!trusted || serverAddress != null) return;
                    using (var picker = new NetworkMenu())
                    {
                        if (picker.ShowDialog(this) != DialogResult.OK) break;
                        if (picker.SelectedAddress != null)
                        {
                            await OpenGroup(picker.SelectedAddress);
                            groupAddress = picker.SelectedAddress;
                        }
                        value = picker.SelectedAddress == null ? "practice" : "group";
                    }
                    break;
                case "join":
                    if (!trusted || serverAddress != null) return;
                    if (!NetworkMenu.TryInvitation(message.Text ?? "", out destination) || destination.Query.Length == 0)
                        throw new InvalidOperationException("请输入好友发来的组网房间号。");
                    if (groupAddress != null && destination.Host == groupAddress.ToString() && destination.Port == NetworkMenu.Port
                        && destination.Query.StartsWith("?room=", StringComparison.Ordinal))
                    {
                        value = destination.Query.Substring(6);
                        destination = null;
                    }
                    else await ConnectGroup(destination, false);
                    break;
                case "resumeGroup":
                    if (!trusted || serverAddress != null) return;
                    destination = ReadRoom();
                    if (destination == null) break;
                    try
                    {
                        await ConnectGroup(destination, true);
                        if (ReadRoom() != destination) destination = null;
                        else destination = new UriBuilder(destination) { Query = destination.Query.Substring(1) + "&resume=1" }.Uri;
                    }
                    catch (LanSignInException failure)
                    {
                        destination = null;
                        if (failure.Status == HttpStatusCode.NotFound || failure.Status == HttpStatusCode.Conflict) File.Delete(RoomFile);
                        error = failure.Message;
                    }
                    catch (HttpRequestException) { destination = null; value = "retry"; }
                    catch (TaskCanceledException) { destination = null; value = "retry"; }
                    break;
                case "forgetGroupResume":
                    if (trusted && serverAddress == null) File.Delete(RoomFile);
                    break;
                case "goHome":
                    if (trusted || serverAddress != null) return;
                    destination = homeAddress;
                    break;
                case "help":
                    if (trusted && serverAddress == null) NetworkMenu.ShowHelp(this);
                    break;
                default:
                    return;
            }
        }
        catch (HttpRequestException) { error = "无法连接房主，请确认组网已连接且房主正在运行游戏。"; }
        catch (TaskCanceledException) { error = "连接房主超时，请检查组网后重试。"; }
        catch (Exception failure) { error = failure.Message; }

        if (IsDisposed || Origin(currentAddress) != Origin(source)) return;
        view.CoreWebView2.PostWebMessageAsJson(archiveJson.Serialize(new { id = message.Id, value, error }));
        if (destination != null && error == null) Navigate(destination);
    }

    private string PreferenceDirectory
    {
        get
        {
            string folder = Environment.GetEnvironmentVariable("RIICHI_DATA_DIR");
            return String.IsNullOrWhiteSpace(folder) ? Program.DataDirectory : folder;
        }
    }

    private string RoomFile { get { return Path.Combine(PreferenceDirectory, "last-lan-room.txt"); } }

    private void LockLocalProfile()
    {
        Directory.CreateDirectory(PreferenceDirectory);
        try { profileLock = File.Open(Path.Combine(PreferenceDirectory, "network-host.lock"), FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None); }
        catch (IOException error) { throw new InvalidOperationException("本机牌桌已在另一窗口运行，请切回该窗口。", error); }
    }

    private Uri ReadRoom()
    {
        try
        {
            Uri room;
            if (File.Exists(RoomFile) && NetworkMenu.TryInvitation(File.ReadAllText(RoomFile), out room)
                && room.Query.StartsWith("?room=", StringComparison.Ordinal)) return room;
        }
        catch (IOException) { }
        return null;
    }

    private void SaveRoom(Uri source, string code)
    {
        if (code == null || !Regex.IsMatch(code, @"\A[0-9]{6}\z")) return;
        Uri room;
        string url = new UriBuilder(source) { Path = "/", Query = "room=" + code }.Uri.AbsoluteUri;
        if (NetworkMenu.TryInvitation(url, out room)) WritePreference(RoomFile, Encoding.UTF8.GetBytes(room.AbsoluteUri));
    }

    private string LoginFile
    {
        get
        {
            string label = "local";
            if (serverAddress != null)
            {
                using (var sha = SHA256.Create())
                    label = BitConverter.ToString(sha.ComputeHash(Encoding.UTF8.GetBytes(Origin(serverAddress)))).Replace("-", "");
            }
            return Path.Combine(PreferenceDirectory, "remembered-login-" + label + ".bin");
        }
    }

    private SavedLogin ReadLogin()
    {
        try
        {
            string file = LoginFile;
            if (!File.Exists(file)) return null;
            byte[] bytes = ProtectedData.Unprotect(File.ReadAllBytes(file), null, DataProtectionScope.CurrentUser);
            return json.Deserialize<SavedLogin>(Encoding.UTF8.GetString(bytes));
        }
        catch (CryptographicException) { return null; }
        catch (IOException) { return null; }
        catch (ArgumentException) { return null; }
    }

    private void SaveLogin(SavedLogin login)
    {
        string file = LoginFile;
        if (login == null || String.IsNullOrEmpty(login.Username))
        {
            File.Delete(file);
            return;
        }
        if (login.Username.Length > 24 || (login.Password != null && login.Password.Length > 128))
            throw new ArgumentException("无法保存登录设置。");
        byte[] bytes = ProtectedData.Protect(Encoding.UTF8.GetBytes(json.Serialize(login)), null, DataProtectionScope.CurrentUser);
        WritePreference(file, bytes);
    }

    private static void WritePreference(string file, byte[] bytes)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(file));
        string temporary = file + "." + Guid.NewGuid().ToString("N");
        try
        {
            File.WriteAllBytes(temporary, bytes);
            if (File.Exists(file)) File.Replace(temporary, file, null);
            else File.Move(temporary, file);
        }
        finally { File.Delete(temporary); }
    }

    private async Task OpenGroup(IPAddress address)
    {
        using (var handler = new HttpClientHandler { AllowAutoRedirect = false, UseProxy = false })
        using (var client = new HttpClient(handler) { Timeout = TimeSpan.FromSeconds(6) })
        {
            client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", desktopControl);
            using (var content = new StringContent(json.Serialize(new { op = "desktopNetwork", address = address.ToString() }), Encoding.UTF8, "application/json"))
            using (var response = await client.PostAsync(new Uri(homeAddress, "/api"), content))
            {
                if (response.StatusCode == HttpStatusCode.NoContent) return;
                var failure = json.Deserialize<Dictionary<string, string>>(await response.Content.ReadAsStringAsync());
                throw new InvalidOperationException(failure["error"]);
            }
        }
    }

    private static HttpClient NewLanClient()
    {
        var handler = new HttpClientHandler { AllowAutoRedirect = false, UseProxy = false, UseCookies = false };
        return new HttpClient(handler) { Timeout = TimeSpan.FromSeconds(6), MaxResponseContentBufferSize = 8 * 1024 * 1024 };
    }

    private async Task<string> SessionCookie(Uri origin)
    {
        var cookies = await view.CoreWebView2.CookieManager.GetCookiesAsync(origin.AbsoluteUri);
        var cookie = cookies.FirstOrDefault(item => item.Name == "riichi_session");
        return cookie == null ? null : cookie.Value;
    }

    private async Task<Dictionary<string, object>> PostLanApi(HttpClient client, Uri origin, object body, string cookie,
        bool challenge = false, bool desktopSync = false, bool large = false)
    {
        var serializer = desktopSync || large ? archiveJson : json;
        using (var request = new HttpRequestMessage(HttpMethod.Post, new Uri(origin, desktopSync ? "/desktop-sync" : "/api")))
        {
            request.Content = new StringContent(serializer.Serialize(body), Encoding.UTF8, "application/json");
            if (cookie != null) request.Headers.Add("Cookie", "riichi_session=" + cookie);
            if (desktopSync) request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", desktopControl);
            using (var response = await client.SendAsync(request))
            {
                if (challenge && response.StatusCode == HttpStatusCode.Unauthorized)
                    throw new LanSignInException(response.StatusCode, "房主需要更新汪汪队后才能使用统一登录。");
                Dictionary<string, object> result = null;
                try { result = serializer.Deserialize<Dictionary<string, object>>(await response.Content.ReadAsStringAsync()); }
                catch (ArgumentException) { }
                catch (InvalidOperationException) { }
                object error;
                if (!response.IsSuccessStatusCode || result == null)
                    throw new LanSignInException(response.StatusCode, result != null && result.TryGetValue("error", out error)
                        ? Convert.ToString(error) : "牌桌返回了无效的登录响应。");
                return result;
            }
        }
    }

    private async Task<object> SyncGroup(Uri origin, string code)
    {
        await groupSync.WaitAsync();
        try
        {
            if (IsDisposed || Origin(currentAddress) != Origin(origin)) return null;
            string local = await SessionCookie(homeAddress), remote = await SessionCookie(origin);
            if (local == null || remote == null) return null;
            using (var client = NewLanClient())
            {
                var current = await PostLanApi(client, origin, new { op = "lanSync", code }, remote);
                var source = current["source"];
                var info = await PostLanApi(client, homeAddress, new { op = "info", source }, local, desktopSync: true);
                var after = info["after"];
                Dictionary<string, object> latest = null;
                bool caughtUp = false;
                for (int i = 0; i < 8; i++)
                {
                    var next = await PostLanApi(client, origin, new { op = "lanArchive", after }, remote, large: true);
                    var entry = next["entry"] as Dictionary<string, object>;
                    if (entry == null) { caughtUp = true; break; }
                    latest = await PostLanApi(client, homeAddress, new { op = "import", source, entry }, local, desktopSync: true);
                    after = entry["seq"];
                }
                var updated = await PostLanApi(client, origin, new { op = "lanSync", code, stats = latest == null ? info["stats"] : latest["stats"] }, remote);
                var saved = await PostLanApi(client, homeAddress, new { op = "peers", source, peers = updated["peers"] }, local, desktopSync: true);
                return new { profile = saved["profile"], latest, caughtUp };
            }
        }
        finally { groupSync.Release(); }
    }

    private async Task ConnectGroup(Uri destination, bool resume)
    {
        var manager = view.CoreWebView2.CookieManager;
        var local = (await manager.GetCookiesAsync(homeAddress.AbsoluteUri)).FirstOrDefault(cookie => cookie.Name == "riichi_session");
        if (local == null) throw new InvalidOperationException("请先在本机大厅登录。");
        var legacy = (await manager.GetCookiesAsync(destination.AbsoluteUri)).FirstOrDefault(cookie => cookie.Name == "riichi_session");
        string code = destination.Query.Substring(6);
        using (var client = NewLanClient())
        {
            var request = await PostLanApi(client, destination, new { op = "lanChallenge", code, resume }, null, true);
            object challenge;
            if (!request.TryGetValue("challenge", out challenge) || !Regex.IsMatch(Convert.ToString(challenge), @"\A[0-9a-f]{64}\z"))
                throw new InvalidOperationException("房主服务器的组网登录版本不兼容。");
            var proof = await PostLanApi(client, homeAddress, new { op = "lanProof", code, challenge, audience = Origin(destination) }, local.Value);
            var session = await PostLanApi(client, destination, new { op = "lanHandoff", proof }, legacy == null ? null : legacy.Value);
            object token;
            if (!session.TryGetValue("token", out token) || !Regex.IsMatch(Convert.ToString(token), @"\A[0-9a-f]{64}\z"))
                throw new InvalidOperationException("房主服务器未返回有效的登录凭证。");
            if (!(await manager.GetCookiesAsync(homeAddress.AbsoluteUri)).Any(c => c.Name == "riichi_session" && c.Value == local.Value))
                throw new InvalidOperationException("本机账号已退出，请重新登录。");
            var cookie = manager.CreateCookie("riichi_session", Convert.ToString(token), destination.Host, "/");
            cookie.IsHttpOnly = true;
            cookie.SameSite = CoreWebView2CookieSameSiteKind.Strict;
            cookie.Expires = DateTime.UtcNow.AddDays(30);
            manager.AddOrUpdateCookie(cookie);
        }
    }

    private sealed class LanSignInException : Exception
    {
        internal HttpStatusCode Status { get; private set; }
        internal LanSignInException(HttpStatusCode status, string message) : base(message) { Status = status; }
    }

    private async Task<Uri> StartServer()
    {
        var setup = new ProcessStartInfo(Path.Combine(runtime, "node.exe"), "server.js --desktop")
        {
            WorkingDirectory = runtime, UseShellExecute = false, CreateNoWindow = true,
            RedirectStandardInput = true, RedirectStandardOutput = true
        };
        if (String.IsNullOrWhiteSpace(setup.EnvironmentVariables["RIICHI_DATA_DIR"]))
            setup.EnvironmentVariables["RIICHI_DATA_DIR"] = Path.Combine(Program.DataDirectory, "network-host");
        setup.EnvironmentVariables["RIICHI_DESKTOP_CONTROL"] = desktopControl;
        server = Process.Start(setup);
        Task<string> ready = server.StandardOutput.ReadLineAsync();
        if (await Task.WhenAny(ready, Task.Delay(12000)) != ready)
            throw new TimeoutException("牌桌服务启动超时。");
        Uri address;
        if (!Uri.TryCreate(await ready, UriKind.Absolute, out address)
            || address.Scheme != Uri.UriSchemeHttp || address.Host != "127.0.0.1")
            throw new InvalidOperationException("牌桌服务未能启动。");
        return address;
    }

    protected override void OnFormClosed(FormClosedEventArgs args)
    {
        reconnect.Dispose();
        if (view != null) view.Dispose();
        StopServer();
        if (profileLock != null) profileLock.Dispose();
        base.OnFormClosed(args);
    }

    private void StopServer()
    {
        Process child = server;
        server = null;
        if (child == null) return;
        using (child)
        {
            try
            {
                if (child.HasExited) return;
                child.StandardInput.Close();
                if (!child.WaitForExit(1100)) child.Kill();
            }
            catch (InvalidOperationException) { }
            catch (IOException) { }
            catch (Win32Exception) { }
        }
    }

    private sealed class DesktopMessage
    {
        public DesktopMessage() { }
        public int Id { get; set; }
        public string Action { get; set; }
        public string Text { get; set; }
        public SavedLogin Login { get; set; }
    }

    private sealed class SavedLogin
    {
        public SavedLogin() { }
        public string Username { get; set; }
        public string Password { get; set; }
    }
}
