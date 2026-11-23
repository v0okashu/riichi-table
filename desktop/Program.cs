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
        using (var window = new GameWindow(runtime, serverAddress))
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
    private readonly string desktopControl = Guid.NewGuid().ToString("N");
    private readonly JavaScriptSerializer json = new JavaScriptSerializer { MaxJsonLength = 4096 };
    private WebView2 view;
    private Process server;
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
        back.LinkClicked += (sender, args) => Navigate(homeAddress);
        layout.Controls.Add(back, 0, 0);
    }

    protected override async void OnShown(EventArgs args)
    {
        base.OnShown(args);
        try
        {
            CoreWebView2Environment.GetAvailableBrowserVersionString();
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
                ";window.riichiDesktop={remember:trusted,network:trusted&&" + (serverAddress == null ? "true" : "false") + "};}");
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
                if (!opened) status.Text = "无法打开牌桌 " + currentAddress.Authority + "。";
                view.Visible = opened;
                status.Visible = !opened;
                if (opened) view.BringToFront();
            };
            web.WebMessageReceived += ReceiveMessage;
            Navigate(new UriBuilder(homeAddress) { Query = "login=1" }.Uri);
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
        currentAddress = address;
        back.Visible = Origin(address) != Origin(homeAddress);
        status.Text = "正在连接牌桌…";
        status.Visible = true;
        view.Visible = false;
        status.BringToFront();
        view.Source = address;
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
                    if (!NetworkMenu.TryInvitation(message.Text ?? "", out destination))
                        throw new InvalidOperationException("请输入好友发来的组网房间号。");
                    if (groupAddress != null && destination.Host == groupAddress.ToString() && destination.Port == NetworkMenu.Port
                        && destination.Query.StartsWith("?room=", StringComparison.Ordinal))
                    {
                        value = destination.Query.Substring(6);
                        destination = null;
                    }
                    else await CheckNetworkServer(destination);
                    break;
                case "help":
                    if (trusted && serverAddress == null) NetworkMenu.ShowHelp(this);
                    break;
                default:
                    return;
            }
        }
        catch (Exception failure) { error = failure.Message; }

        if (IsDisposed || Origin(currentAddress) != Origin(source)) return;
        view.CoreWebView2.PostWebMessageAsJson(json.Serialize(new { id = message.Id, value, error }));
        if (destination != null && error == null) Navigate(destination);
    }

    private string LoginFile
    {
        get
        {
            string folder = Environment.GetEnvironmentVariable("RIICHI_DATA_DIR");
            if (String.IsNullOrWhiteSpace(folder)) folder = Program.DataDirectory;
            string label = "local";
            if (serverAddress != null)
            {
                using (var sha = SHA256.Create())
                    label = BitConverter.ToString(sha.ComputeHash(Encoding.UTF8.GetBytes(Origin(serverAddress)))).Replace("-", "");
            }
            return Path.Combine(folder, "remembered-login-" + label + ".bin");
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

    private static async Task CheckNetworkServer(Uri destination)
    {
        using (var handler = new HttpClientHandler { AllowAutoRedirect = false, UseProxy = false })
        using (var client = new HttpClient(handler) { Timeout = TimeSpan.FromSeconds(6) })
        {
            try
            {
                using (var probe = await client.GetAsync(new Uri(destination, "/health")))
                {
                    IEnumerable<string> values;
                    if (probe.StatusCode == HttpStatusCode.NoContent
                        && probe.Headers.TryGetValues("X-WangWang-Server", out values)
                        && values.Contains("riichi-table")) return;
                }
            }
            catch (HttpRequestException) { }
            catch (TaskCanceledException) { }
        }
        throw new InvalidOperationException("无法连接牌桌。请确认房主已开桌、你们的组网可以互访，且房主的 TCP 8787 端口可访问。");
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
        if (view != null) view.Dispose();
        StopServer();
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
