using System;

namespace Slop.SolidWorks.Core
{
    /// <summary>3-vectors as double[3]. Matches geometry.ts on the Onshape side.</summary>
    public static class Vec
    {
        public static double[] Of(double x, double y, double z) => new[] { x, y, z };

        /// <summary>Three doubles starting at <paramref name="offset"/> of a SOLIDWORKS array.</summary>
        public static double[] At(double[] a, int offset) => new[] { a[offset], a[offset + 1], a[offset + 2] };

        public static double[] Add(double[] a, double[] b) => new[] { a[0] + b[0], a[1] + b[1], a[2] + b[2] };
        public static double[] Sub(double[] a, double[] b) => new[] { a[0] - b[0], a[1] - b[1], a[2] - b[2] };
        public static double[] Scale(double[] a, double s) => new[] { a[0] * s, a[1] * s, a[2] * s };
        public static double Dot(double[] a, double[] b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

        public static double[] Cross(double[] a, double[] b) => new[]
        {
            a[1] * b[2] - a[2] * b[1],
            a[2] * b[0] - a[0] * b[2],
            a[0] * b[1] - a[1] * b[0],
        };

        public static double Norm(double[] a) => Math.Sqrt(Dot(a, a));
        public static double Dist(double[] a, double[] b) => Norm(Sub(a, b));
        public static double[] Mid(double[] a, double[] b) => Scale(Add(a, b), 0.5);

        public static double[] Normalize(double[] a)
        {
            double n = Norm(a);
            if (n == 0) throw new ArgumentException("cannot normalize a zero vector");
            return Scale(a, 1 / n);
        }

        /// <summary>True when the unit vectors are parallel (either sense) within <paramref name="tol"/> rad.</summary>
        public static bool Parallel(double[] a, double[] b, double tol = 1e-9) => Math.Abs(Math.Abs(Dot(Normalize(a), Normalize(b))) - 1) <= tol;
    }

    /// <summary>
    /// Conversions between SOLIDWORKS transforms and the IR's Mat4.
    ///
    /// SOLIDWORKS (IMathTransform.ArrayData, 16 doubles) uses the row-vector
    /// convention: elements 0-8 are a 3x3 rotation whose rows are the images of
    /// the x, y and z axes, 9-11 the translation, 12 a uniform scale and 13-15
    /// unused. The IR's Mat4 is row-major with column vectors (types.ts,
    /// geometry.ts applyPoint), so the rotation is transposed and the
    /// translation becomes the last column.
    /// </summary>
    public static class Transforms
    {
        public static double[] ToIrMat4(double[] sw)
        {
            if (sw == null || sw.Length < 13) throw new ArgumentException("a SOLIDWORKS transform has 16 elements");
            double s = sw[12];
            return new[]
            {
                sw[0] * s, sw[3] * s, sw[6] * s, sw[9],
                sw[1] * s, sw[4] * s, sw[7] * s, sw[10],
                sw[2] * s, sw[5] * s, sw[8] * s, sw[11],
                0, 0, 0, 1,
            };
        }

        public static double[] ApplyPoint(double[] m, double x, double y, double z) => new[]
        {
            m[0] * x + m[1] * y + m[2] * z + m[3],
            m[4] * x + m[5] * y + m[6] * z + m[7],
            m[8] * x + m[9] * y + m[10] * z + m[11],
        };

        public static double[] ApplyDir(double[] m, double x, double y, double z) => new[]
        {
            m[0] * x + m[1] * y + m[2] * z,
            m[4] * x + m[5] * y + m[6] * z,
            m[8] * x + m[9] * y + m[10] * z,
        };

        /// <summary>Model coordinates of the sketch frame's axes and origin.</summary>
        public static double[] XAxis(double[] m) => ApplyDir(m, 1, 0, 0);
        public static double[] YAxis(double[] m) => ApplyDir(m, 0, 1, 0);
        public static double[] Normal(double[] m) => ApplyDir(m, 0, 0, 1);
        public static double[] Origin(double[] m) => ApplyPoint(m, 0, 0, 0);
    }

    /// <summary>Planar arc arithmetic in sketch coordinates.</summary>
    public static class Arcs
    {
        /// <summary>Counter-clockwise sweep from p0 to p1 about <paramref name="c"/>, in (0, 2π].</summary>
        public static double CcwSweep(double[] c, double[] p0, double[] p1)
        {
            double a0 = Math.Atan2(p0[1] - c[1], p0[0] - c[0]);
            double a1 = Math.Atan2(p1[1] - c[1], p1[0] - c[0]);
            double sweep = a1 - a0;
            while (sweep <= 0) sweep += 2 * Math.PI;
            while (sweep > 2 * Math.PI) sweep -= 2 * Math.PI;
            return sweep;
        }

        /// <summary>
        /// Direction of an arc from its measured length: true when the
        /// counter-clockwise sweep from p0 to p1 explains <paramref name="length"/>,
        /// false when the clockwise one does, null when both do (a semicircle)
        /// or neither does.
        /// </summary>
        public static bool? CcwFromLength(double[] c, double[] p0, double[] p1, double length, double tol = 1e-7)
        {
            double r = Math.Sqrt((p0[0] - c[0]) * (p0[0] - c[0]) + (p0[1] - c[1]) * (p0[1] - c[1]));
            if (r <= 0) return null;
            double ccw = r * CcwSweep(c, p0, p1);
            double cw = r * (2 * Math.PI) - ccw;
            double tolerance = tol * Math.Max(1, length);
            bool ccwFits = Math.Abs(ccw - length) <= tolerance;
            bool cwFits = Math.Abs(cw - length) <= tolerance;
            if (ccwFits == cwFits) return null;
            return ccwFits;
        }
    }
}
