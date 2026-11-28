using System;
using System.Drawing;
using System.Globalization;
using System.Linq;
using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Text.RegularExpressions;
using System.Windows.Forms;

internal sealed class NetworkMenu : Form
{
    internal const int Port = 8787;
    private const string RoomAlphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
    private const uint RoomCount = 900000;
    // Keep the order and sizes aligned with groupRanges in server.js.
    private static readonly AddressRange[] GroupRanges =
    {
        new AddressRange(0x0a000000, 0x01000000),
        new AddressRange(0xac100000, 0x00100000),
        new AddressRange(0xc0a80000, 0x00010000),
        new AddressRange(0x64400000, 0x00400000)
    };
    internal IPAddress SelectedAddress { get; private set; }

    private readonly ComboBox adapters = new ComboBox { Dock = DockStyle.Fill, DropDownStyle = ComboBoxStyle.DropDownList };
    private readonly Label feedback = new Label { AutoSize = true, ForeColor = Color.FromArgb(255, 220, 156) };

    internal NetworkMenu()
    {
        Text = "选择组网";
        ClientSize = new Size(550, 214);
        StartPosition = FormStartPosition.CenterParent;
        FormBorderStyle = FormBorderStyle.FixedDialog;
        ShowInTaskbar = false;
        MinimizeBox = MaximizeBox = false;
        BackColor = Color.FromArgb(16, 40, 38);
        ForeColor = Color.FromArgb(245, 240, 220);
        Font = new Font("Microsoft YaHei UI", 10);

        var content = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 1, Padding = new Padding(16) };
        Controls.Add(content);
        content.Controls.Add(Instruction("选择蒲公英或其他组网的网卡，开桌后把房间号发给朋友。"));
        var row = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 2, Height = 42, Margin = Padding.Empty };
        row.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        row.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
        adapters.Margin = new Padding(0, 8, 8, 0);
        adapters.AccessibleName = "组网网卡";
        row.Controls.Add(adapters, 0, 0);
        row.Controls.Add(CreateButton("刷新", RefreshAdapters), 1, 0);
        content.Controls.Add(row);

        var footer = new FlowLayoutPanel { Dock = DockStyle.Fill, Height = 43, Margin = new Padding(0, 8, 0, 0) };
        var create = CreateButton("创建组网房间", HostSelected);
        var cancel = CreateButton("取消", () => { DialogResult = DialogResult.Cancel; });
        footer.Controls.Add(create);
        footer.Controls.Add(CreateButton("本机练习", () => { DialogResult = DialogResult.OK; }));
        footer.Controls.Add(CreateButton("组网帮助", () => ShowHelp(this)));
        footer.Controls.Add(cancel);
        AcceptButton = create;
        CancelButton = cancel;
        content.Controls.Add(footer);
        feedback.MaximumSize = new Size(510, 0);
        content.Controls.Add(feedback);
        RefreshAdapters();
    }

    private void ShowError(string message)
    {
        feedback.Text = message;
    }

    private static Label Instruction(string text)
    {
        return new Label { Text = text, AutoSize = true, MaximumSize = new Size(536, 0), Margin = new Padding(0, 9, 0, 5) };
    }

    private static Button CreateButton(string text, Action click)
    {
        var button = new Button
        {
            Text = text, AutoSize = true, Height = 35, Padding = new Padding(8, 1, 8, 1),
            Margin = new Padding(0, 0, 8, 0), FlatStyle = FlatStyle.Flat, ForeColor = Color.FromArgb(22, 48, 40),
            BackColor = Color.FromArgb(238, 219, 165), UseVisualStyleBackColor = false
        };
        button.FlatAppearance.BorderSize = 0;
        button.Click += (sender, args) => click();
        return button;
    }

    private void RefreshAdapters()
    {
        var preferred = adapters.SelectedItem as NetworkAddress;
        adapters.Items.Clear();
        var addresses = NetworkInterface.GetAllNetworkInterfaces()
            .Where(adapter => adapter.OperationalStatus == OperationalStatus.Up)
            .SelectMany(adapter => adapter.GetIPProperties().UnicastAddresses
                .Where(unicast => IsGroupAddress(unicast.Address))
                .Select(unicast => new NetworkAddress(adapter, unicast.Address)))
            .OrderByDescending(address => address.IsPgy)
            .ThenBy(address => address.Name, StringComparer.CurrentCultureIgnoreCase)
            .ToArray();
        adapters.Items.AddRange(addresses);
        var selected = preferred == null ? -1 : Array.FindIndex(addresses, address => address.Address.Equals(preferred.Address));
        if (addresses.Length != 0) adapters.SelectedIndex = selected >= 0 ? selected : 0;
        ShowError(addresses.Length == 0 ? "连上组网后，点「刷新」重新查找网卡。" : "");
    }

    private void HostSelected()
    {
        var picked = adapters.SelectedItem as NetworkAddress;
        if (picked == null)
        {
            ShowError("请先连接组网并选择一张组网网卡。");
            return;
        }
        SelectedAddress = picked.Address;
        DialogResult = DialogResult.OK;
    }

    internal static bool TryInvitation(string input, out Uri address)
    {
        string supplied = input.Trim();
        if (TryGroupRoom(supplied, out address)) return true;
        IPAddress ip;
        if (IPAddress.TryParse(supplied, out ip) && IsGroupAddress(ip))
            supplied = new UriBuilder("http", ip.ToString(), Port).Uri.AbsoluteUri;
        else if (!supplied.Contains("://"))
            supplied = "http://" + supplied;
        Uri target;
        if (!Uri.TryCreate(supplied, UriKind.Absolute, out target) || target.Scheme != Uri.UriSchemeHttp
            || !IPAddress.TryParse(target.Host, out ip) || !IsGroupAddress(ip) || target.Port < 1
            || target.AbsolutePath != "/" || target.UserInfo.Length != 0 || target.Fragment.Length != 0
            || (target.Query.Length != 0 && !Regex.IsMatch(target.Query, @"\A\?room=[0-9]{6}\z")))
            return false;
        address = target;
        return true;
    }

    private static bool TryGroupRoom(string input, out Uri address)
    {
        address = null;
        char[] code = input.ToUpperInvariant().Where(c => c != '-' && !Char.IsWhiteSpace(c)).ToArray();
        if (code.Length != 9) return false;
        ulong value = 0;
        foreach (char c in code)
        {
            int digit = RoomAlphabet.IndexOf(c == 'O' ? '0' : c == 'I' || c == 'L' ? '1' : c);
            if (digit < 0) return false;
            value = value * 32 + (uint)digit;
        }
        uint offset = (uint)(value / RoomCount);
        foreach (var range in GroupRanges)
        {
            if (offset >= range.Size)
            {
                offset -= range.Size;
                continue;
            }
            uint ip = range.Start + offset;
            var octets = new byte[] { (byte)(ip >> 24), (byte)(ip >> 16), (byte)(ip >> 8), (byte)ip };
            string room = (value % RoomCount + 100000).ToString(CultureInfo.InvariantCulture);
            address = new UriBuilder("http", new IPAddress(octets).ToString(), Port) { Query = "room=" + room }.Uri;
            return true;
        }
        return false;
    }

    private static bool IsGroupAddress(IPAddress address)
    {
        if (address.AddressFamily != AddressFamily.InterNetwork) return false;
        uint value = address.GetAddressBytes().Aggregate(0u, (ip, octet) => (ip << 8) + octet);
        return GroupRanges.Any(range => value >= range.Start && value < range.Start + range.Size);
    }

    internal static void ShowHelp(IWin32Window owner)
    {
        MessageBox.Show(owner,
            "1. 所有玩家先加入同一个蒲公英或其他组网，并确认朋友可以访问房主设备。\n\n" +
            "2. 房主登录后，在大厅点击「创建房间」，选择组网网卡并开桌。点音效键旁的「复制房间号」发给朋友。房主保持游戏和组网在线。\n\n" +
            "3. 朋友在自己的汪汪队登录后，在大厅输入房间号即可入座。\n\n" +
            "连不上时，先核对房主选的网卡。若 Windows 防火墙阻挡，请允许汪汪队后台通过该组网接口接收入站 TCP " + Port + "。请只连接你信任的组网和房主。",
            "组网帮助", MessageBoxButtons.OK, MessageBoxIcon.Information);
    }

    private struct AddressRange
    {
        internal readonly uint Start;
        internal readonly uint Size;

        internal AddressRange(uint start, uint size)
        {
            Start = start;
            Size = size;
        }
    }

    private sealed class NetworkAddress
    {
        internal readonly string Name;
        internal readonly IPAddress Address;
        internal readonly bool IsPgy;

        internal NetworkAddress(NetworkInterface adapter, IPAddress address)
        {
            IsPgy = adapter.Name.Contains("蒲公英") || adapter.Description.Contains("蒲公英")
                || adapter.Description.IndexOf("OrayBoxVpn", StringComparison.OrdinalIgnoreCase) >= 0;
            Name = IsPgy && !adapter.Name.Contains("蒲公英") ? "蒲公英（" + adapter.Name + "）" : adapter.Name;
            Address = address;
        }

        public override string ToString()
        {
            return Name + "  ·  " + Address;
        }
    }
}
