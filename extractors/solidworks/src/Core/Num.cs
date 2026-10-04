using System;
using System.Globalization;

namespace Slop.SolidWorks.Core
{
    /// <summary>
    /// Number hygiene for everything written to the IR.
    ///
    /// SOLIDWORKS reports values with solver noise in the last bits
    /// (0.049999999999999996 for a 50 mm dimension, -1.2e-17 for zero). Values
    /// are rounded to 12 significant digits, well inside both the 1e-6
    /// tolerances the Onshape side checks against and double precision, and
    /// anything smaller than <see cref="Zero"/> is written as 0. The IR's own
    /// canonical form rounds to 15 digits on top of this, so the two never
    /// disagree.
    /// </summary>
    public static class Num
    {
        /// <summary>Below this magnitude a value is noise: 1 pm, 1 prad, 1 pm² ...</summary>
        public const double Zero = 1e-12;

        private static readonly CultureInfo Inv = CultureInfo.InvariantCulture;

        public static double Clean(double x)
        {
            if (double.IsNaN(x) || double.IsInfinity(x)) throw new ArgumentException($"non-finite number {x} cannot go into the IR");
            if (Math.Abs(x) < Zero) return 0;
            return double.Parse(x.ToString("G12", Inv), NumberStyles.Float, Inv);
        }

        /// <summary>JSON text for a cleaned value: integers without a fraction, the rest round-trip.</summary>
        public static string Format(double x)
        {
            x = Clean(x);
            if (x == Math.Floor(x) && Math.Abs(x) < 1e15) return ((long)x).ToString(Inv);
            return x.ToString("R", Inv);
        }

        /// <summary>Equality for values that went through the kernel: absolute below 1, relative above.</summary>
        public static bool Near(double a, double b, double tol = 1e-9) => Math.Abs(a - b) <= tol * Math.Max(1, Math.Max(Math.Abs(a), Math.Abs(b)));
    }
}
