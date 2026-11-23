// Build the procedural face designs into both the CSS atlas and the 3D modeller's BGRA sample.
// Build with the .NET Framework C# compiler and reference System.Drawing.dll.
// Pass the source PNG, source BGRA sample, output PNG and output BGRA sample in that order.
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;

internal static class BuildFaces
{
    const int FaceWidth = 192, FaceHeight = 264, SampleWidth = 76, SampleHeight = 104, Columns = 9;
    static readonly Color Black = Color.FromArgb(32, 36, 40);
    static readonly Color Red = Color.FromArgb(113, 42, 52);
    static readonly Color RedFive = Color.FromArgb(157, 47, 56);
    static readonly Color Green = Color.FromArgb(32, 72, 57);
    static readonly Color Highlight = Color.FromArgb(160, 202, 192, 160);

    public static void Main(string[] args)
    {
        if (args.Length != 4) throw new ArgumentException("Expected source PNG, source BGRA, output PNG and output BGRA");
        byte[] pixels = File.ReadAllBytes(args[1]);
        if (pixels.Length != Columns * SampleWidth * 5 * SampleHeight * 4)
            throw new ArgumentException("Expected a 684 x 520 BGRA atlas");
        using (var atlas = new Bitmap(args[0]))
        {
            if (atlas.Width != 9 * FaceWidth || atlas.Height != 5 * FaceHeight)
                throw new ArgumentException("Expected a 1728 x 1320 PNG atlas");
            using (var target = Graphics.FromImage(atlas))
            {
                for (int number = 2; number <= 9; number++)
                {
                    int pin = number;
                    PaintFace(target, pixels, number - 1, 1, g => DrawCircles(g, Circles(pin)));
                }
                PaintFace(target, pixels, 1, 4, g => DrawCircles(g, Circles(5, true)));
                for (int number = 2; number <= 9; number++)
                {
                    int bamboo = number;
                    PaintFace(target, pixels, number - 1, 2, g => DrawEnlargedBamboo(g, bamboo));
                }
                PaintFace(target, pixels, 2, 4, g => DrawEnlargedBamboo(g, 5, true));
            }
            atlas.Save(args[2], ImageFormat.Png);
        }
        File.WriteAllBytes(args[3], pixels);
    }

    static void PaintFace(Graphics atlas, byte[] pixels, int col, int row, Action<Graphics> paint)
    {
        using (var face = new Bitmap(FaceWidth, FaceHeight, PixelFormat.Format32bppArgb))
        using (var sample = new Bitmap(SampleWidth, SampleHeight, PixelFormat.Format32bppArgb))
        {
            using (var g = Graphics.FromImage(face))
            {
                g.Clear(Color.White);
                g.SmoothingMode = SmoothingMode.AntiAlias;
                paint(g);
            }
            atlas.DrawImageUnscaled(face, col * FaceWidth, row * FaceHeight);
            using (var g = Graphics.FromImage(sample))
            {
                g.Clear(Color.White);
                g.InterpolationMode = InterpolationMode.HighQualityBicubic;
                g.PixelOffsetMode = PixelOffsetMode.HighQuality;
                g.DrawImage(face, new Rectangle(0, 0, SampleWidth, SampleHeight));
            }
            var sampleBits = sample.LockBits(new Rectangle(0, 0, SampleWidth, SampleHeight),
                ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
            try
            {
                for (int y = 0; y < SampleHeight; y++)
                {
                    int offset = ((row * SampleHeight + y) * Columns + col) * SampleWidth * 4;
                    Marshal.Copy(IntPtr.Add(sampleBits.Scan0, y * sampleBits.Stride), pixels, offset, SampleWidth * 4);
                }
            }
            finally { sample.UnlockBits(sampleBits); }
        }
    }

    struct Circle
    {
        internal readonly float X, Y, Radius;
        internal readonly Color Colour;

        internal Circle(float x, float y, float radius, Color colour)
        {
            X = x;
            Y = y;
            Radius = radius;
            Colour = colour;
        }
    }

    static List<Circle> Circles(int number, bool redFive = false)
    {
        const float enlarged = 1.2f;
        const float upper = 43.5f, centre = 132f, lower = 220.5f;
        var circles = new List<Circle>();
        if (number == 2)
        {
            circles.Add(new Circle(96, 70, 44, Black));
            circles.Add(new Circle(96, 194, 44, Black));
        }
        else if (number == 3)
        {
            circles.Add(new Circle(48, upper, 29 * enlarged, Black));
            circles.Add(new Circle(96, centre, 29 * enlarged, Red));
            circles.Add(new Circle(144, lower, 29 * enlarged, Black));
        }
        else if (number <= 6)
        {
            float radius = 29 * enlarged;
            Color topInk = redFive ? RedFive : Black;
            Pair(circles, upper, radius, topInk, 38);
            if (number == 5) circles.Add(new Circle(96, centre, radius, redFive ? RedFive : Red));
            if (number == 6) Pair(circles, centre, radius, Red, 38);
            Pair(circles, lower, radius, number == 6 ? Red : topInk, 38);
        }
        else if (number == 7)
        {
            circles.Add(new Circle(40, 34, 24 * enlarged, Black));
            circles.Add(new Circle(96, 65, 24 * enlarged, Black));
            circles.Add(new Circle(152, 96, 24 * enlarged, Black));
            Pair(circles, 158, 26 * enlarged, Red, 35);
            Pair(circles, 225, 26 * enlarged, Red, 35);
        }
        else if (number == 8)
        {
            foreach (float y in new[] {42f, 102f, 162f, 222f}) Pair(circles, y, 23 * enlarged, Black, 37);
        }
        else
        {
            foreach (float y in new[] {upper, centre, lower})
                foreach (float x in new[] {35.5f, 96f, 156.5f}) circles.Add(new Circle(x, y, 23 * enlarged, Black));
        }
        return circles;
    }

    static void Pair(List<Circle> circles, float y, float radius, Color colour, float halfWidth)
    {
        circles.Add(new Circle(96 - halfWidth, y, radius, colour));
        circles.Add(new Circle(96 + halfWidth, y, radius, colour));
    }

    static void DrawCircles(Graphics g, List<Circle> circles)
    {
        for (int i = 0; i < circles.Count; i++)
        {
            var circle = circles[i];
            float x = circle.X, y = circle.Y, r = circle.Radius;
            if (x - r < 0 || y - r < 0 || x + r > FaceWidth || y + r > FaceHeight)
                throw new InvalidOperationException("A circle extends past the face");
            for (int j = 0; j < i; j++)
            {
                var previous = circles[j];
                float dx = x - previous.X, dy = y - previous.Y, diameter = r + previous.Radius;
                if (dx * dx + dy * dy <= diameter * diameter)
                    throw new InvalidOperationException("Circles overlap");
            }
            using (var ink = new SolidBrush(circle.Colour))
            {
                Dot(g, ink, x, y, r);
                Dot(g, Brushes.Ivory, x, y, r * .58f);
                for (int k = 0; k < 8; k++)
                {
                    double angle = k * Math.PI / 4;
                    Dot(g, Brushes.Ivory, x + (float)Math.Cos(angle) * r * .78f,
                        y + (float)Math.Sin(angle) * r * .78f, r * .105f);
                }
                Dot(g, ink, x, y, r * .39f);
                Dot(g, Brushes.Ivory, x, y, r * .13f);
            }
        }
    }

    static void Dot(Graphics g, Brush brush, float x, float y, float radius)
    {
        g.FillEllipse(brush, x - radius, y - radius, radius * 2, radius * 2);
    }

    // Straight segment of the former two-bamboo face, measured in atlas pixels.
    const float ReferenceBambooStroke = 22f;
    const float BambooStroke = ReferenceBambooStroke * 1.30f;
    const float BambooScale = 1.10f;
    const float BambooWidthScale = .90f;
    const float FiveBambooLength = (58f + 16.3f) * 1.20f;

    static void DrawEnlargedBamboo(Graphics g, int number, bool redFive = false)
    {
        var state = g.Save();
        g.TranslateTransform(96, 132);
        g.ScaleTransform(BambooScale, BambooScale);
        g.TranslateTransform(-96, -132);
        switch (number)
        {
            case 2:
                DrawStem(g, 96, 75, 92, Green);
                DrawStem(g, 96, 189, 92, Green);
                break;
            case 3:
                // The modeller and CSS both rotate this atlas cell to give one above two.
                DrawBambooRow(g, 78, 102.3f, 41, 2);
                DrawStem(g, 96, 186, 102.3f, Green);
                break;
            case 4:
                DrawBambooRow(g, 78, 102.3f, 30, 2);
                DrawBambooRow(g, 186, 102.3f, 30, 2);
                break;
            case 5:
                const float x = 37 * .8f * 1.30f, y = 67f, jointSpan = 42f;
                Color outer = redFive ? RedFive : Green;
                foreach (float row in new[] {132 - y, 132 + y})
                {
                    DrawStem(g, 96 - x, row, FiveBambooLength, outer, jointSpan);
                    DrawStem(g, 96 + x, row, FiveBambooLength, outer, jointSpan);
                }
                DrawStem(g, 96, 132, FiveBambooLength, redFive ? RedFive : Red, jointSpan);
                break;
            case 6:
                DrawBambooRow(g, 78, 102.3f, 46, 3);
                DrawBambooRow(g, 186, 102.3f, 46, 3);
                break;
            case 7:
            case 9:
                const float pitch = 88.5f * .84f, length = 68 * 1.10f * .84f;
                for (int row = -1; row <= 1; row++)
                {
                    float rowY = 132 + row * pitch;
                    if (number == 7 && row == -1)
                        DrawStem(g, 96, rowY, length, Red, 42);
                    else
                        DrawBambooRow(g, rowY, length, 46, 3, redCentre: number == 9);
                }
                break;
            case 8:
                DrawBambooBridge(g, 74.4f, 106.8f, 64.5f);
                DrawBambooBridge(g, 187.8f, 155.4f, 197.7f);
                break;
        }
        g.Restore(state);
    }

    static void DrawBambooRow(Graphics g, float y, float length, float halfWidth, int count, bool redCentre = false)
    {
        float jointSpan = count == 3 ? 42 : 48;
        DrawStem(g, 96 - halfWidth, y, length, Green, jointSpan);
        if (count == 3) DrawStem(g, 96, y, length, redCentre ? Red : Green, jointSpan);
        DrawStem(g, 96 + halfWidth, y, length, Green, jointSpan);
    }

    static Pen RoundPen(Color ink, float width)
    {
        return new Pen(ink, width) { StartCap = LineCap.Round, EndCap = LineCap.Round, LineJoin = LineJoin.Round };
    }

    static void DrawStem(Graphics g, float x, float y, float length, Color ink, float jointSpan = 48)
    {
        float tip = (length - BambooStroke) / 2;
        const float jointWidth = BambooStroke * .42f;
        float jointReach = (jointSpan - jointWidth) / 2;
        var state = g.Save();
        g.TranslateTransform(x, y);
        g.ScaleTransform(BambooWidthScale, 1);
        using (var pen = RoundPen(ink, BambooStroke))
        {
            g.DrawLine(pen, 0, -tip, 0, tip);
            pen.Width = jointWidth;
            foreach (float joint in new[] {-tip, 0, tip})
                g.DrawLine(pen, -jointReach, joint, jointReach, joint);
        }
        using (var glint = RoundPen(Highlight, 2))
            g.DrawLine(glint, -3, -tip * .68f, -3, tip * .68f);
        g.Restore(state);
    }

    static void DrawBambooBridge(Graphics g, float centreY, float shoulderY, float apexY)
    {
        const float left = 47.4f, right = 144.6f;
        const float width = BambooStroke * .90f * BambooWidthScale;
        var path = new[] {new PointF(left, shoulderY), new PointF(96, apexY), new PointF(right, shoulderY)};
        using (var bridge = RoundPen(Green, width))
        {
            g.DrawLines(bridge, path);
            bridge.Width = width * .46f;
            for (int i = 0; i < path.Length - 1; i++)
            {
                var from = path[i];
                var to = path[i + 1];
                float dx = to.X - from.X, dy = to.Y - from.Y;
                float reach = width * .65f / (float)Math.Sqrt(dx * dx + dy * dy);
                float x = (from.X + to.X) / 2, y = (from.Y + to.Y) / 2;
                g.DrawLine(bridge, x + dy * reach, y - dx * reach, x - dy * reach, y + dx * reach);
            }
        }
        DrawStem(g, left, centreY, 92.8f, Green);
        DrawStem(g, right, centreY, 92.8f, Green);
        using (var glint = RoundPen(Highlight, 2))
        {
            for (int i = 0; i < path.Length - 1; i++)
            {
                var from = path[i];
                var to = path[i + 1];
                g.DrawLine(glint, from.X + (to.X - from.X) * .26f, from.Y + (to.Y - from.Y) * .26f - 3,
                    from.X + (to.X - from.X) * .74f, from.Y + (to.Y - from.Y) * .74f - 3);
            }
        }
    }
}
