using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

internal static class Program
{
    internal const string Title = "汪汪队 · 立直对局室";
    internal static readonly string DataDirectory = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "WangWangRiichi");
    private const string PackageResource = "WangWangRiichi.Game.zip";

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr LoadLibrary(string path);

    [STAThread]
    private static int Main()
    {
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);

        try
        {
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

            ShowGame(runtime);
            return 0;
        }
        catch (Exception error)
        {
            MessageBox.Show(error.Message, Title, MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
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
    private static void ShowGame(string runtime)
    {
        using (var window = new GameWindow(runtime))
            Application.Run(window);
    }
}

internal sealed class GameWindow : Form
{
    private readonly string runtime;
    private readonly Label status;
    private WebView2 view;
    private Process server;

    internal GameWindow(string runtime)
    {
        this.runtime = runtime;
        Text = Program.Title;
        StartPosition = FormStartPosition.CenterScreen;
        ClientSize = new Size(1170, 835);
        MinimumSize = new Size(620, 520);
        BackColor = Color.FromArgb(16, 40, 38);
        status = new Label
        {
            Dock = DockStyle.Fill, ForeColor = Color.FromArgb(245, 240, 220),
            TextAlign = ContentAlignment.MiddleCenter, Text = "正在打开牌桌…",
            Font = new Font("Microsoft YaHei UI", 11)
        };
        Controls.Add(status);
    }

    protected override async void OnShown(EventArgs args)
    {
        base.OnShown(args);
        try
        {
            CoreWebView2Environment.GetAvailableBrowserVersionString();
            Uri address = await StartServer();
            if (IsDisposed) return;

            view = new WebView2 { Dock = DockStyle.Fill, Visible = false,
                DefaultBackgroundColor = BackColor };
            Controls.Add(view);
            string browserData = Path.Combine(Program.DataDirectory, "desktop-browser");
            var environment = await CoreWebView2Environment.CreateAsync(null, browserData);
            if (IsDisposed) return;
            await view.EnsureCoreWebView2Async(environment);
            if (IsDisposed) return;

            var web = view.CoreWebView2;
            web.Settings.AreDevToolsEnabled = false;
            web.Settings.AreDefaultContextMenusEnabled = false;
            web.NavigationStarting += (sender, navigation) =>
            {
                Uri target;
                navigation.Cancel = !Uri.TryCreate(navigation.Uri, UriKind.Absolute, out target)
                    || target.GetLeftPart(UriPartial.Authority) != address.GetLeftPart(UriPartial.Authority);
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
                if (!navigation.IsSuccess)
                {
                    status.Text = "无法打开牌桌，请关闭程序后重试。";
                    return;
                }
                status.Visible = false;
                view.Visible = true;
                view.BringToFront();
            };
            view.Source = address;
        }
        catch (WebView2RuntimeNotFoundException)
        {
            if (!IsDisposed) status.Text = "请安装 Microsoft Edge WebView2 Runtime，再重新打开汪汪队。";
            StopServer();
        }
        catch (Exception error)
        {
            if (!IsDisposed) status.Text = "启动失败\n" + error.Message;
            StopServer();
        }
    }

    private async Task<Uri> StartServer()
    {
        var setup = new ProcessStartInfo(Path.Combine(runtime, "node.exe"), "server.js --desktop")
        {
            WorkingDirectory = runtime, UseShellExecute = false, CreateNoWindow = true,
            RedirectStandardInput = true, RedirectStandardOutput = true
        };
        if (String.IsNullOrWhiteSpace(setup.EnvironmentVariables["RIICHI_DATA_DIR"]))
            setup.EnvironmentVariables["RIICHI_DATA_DIR"] = Program.DataDirectory;

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
}
