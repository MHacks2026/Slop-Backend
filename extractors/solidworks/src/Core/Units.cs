using System;
using System.Globalization;

namespace Slop.SolidWorks.Core
{
    /// <summary>
    /// The document's display units, used only to write source expressions
    /// ("50 mm", "90 deg"). Values in the IR are always SI; the expression is
    /// how the designer typed it, and the Onshape builder passes literals of
    /// this form through unchanged (see expression.ts, LITERAL).
    /// </summary>
    public sealed class Units
    {
        public string LengthSymbol { get; }
        public double MetersPerUnit { get; }
        public string AngleSymbol { get; }
        public double RadiansPerUnit { get; }

        public Units(string lengthSymbol, double metersPerUnit, string angleSymbol, double radiansPerUnit)
        {
            LengthSymbol = lengthSymbol;
            MetersPerUnit = metersPerUnit;
            AngleSymbol = angleSymbol;
            RadiansPerUnit = radiansPerUnit;
        }

        public static readonly Units Millimeters = new Units("mm", 1e-3, "deg", Math.PI / 180);

        /// <summary>
        /// From swLengthUnit_e and swAngleUnit_e. Units Onshape cannot parse in an
        /// expression (microns, mils, feet-inches, ...) fall back to millimetres.
        /// </summary>
        public static Units FromSolidWorks(int lengthUnit, int angleUnit)
        {
            string symbol;
            double factor;
            switch (lengthUnit)
            {
                case 1: symbol = "cm"; factor = 1e-2; break; // swCM
                case 2: symbol = "m"; factor = 1; break; // swMETER
                case 3: symbol = "in"; factor = 0.0254; break; // swINCHES
                case 4: symbol = "ft"; factor = 0.3048; break; // swFEET
                case 5: symbol = "in"; factor = 0.0254; break; // swFEETINCHES
                default: symbol = "mm"; factor = 1e-3; break; // swMM and the rest
            }
            bool radians = angleUnit == 3; // swRADIANS
            return new Units(symbol, factor, radians ? "rad" : "deg", radians ? 1 : Math.PI / 180);
        }

        public string Length(double meters) => $"{FormatNumber(meters / MetersPerUnit)} {LengthSymbol}";

        public string Angle(double radians) => $"{FormatNumber(radians / RadiansPerUnit)} {AngleSymbol}";

        /// <summary>Plain decimal, 10 significant digits, no exponent: 50, 2.5, 0.125, -12.7.</summary>
        public static string FormatNumber(double x)
        {
            if (double.IsNaN(x) || double.IsInfinity(x)) throw new ArgumentException($"non-finite number {x}");
            if (Math.Abs(x) < 1e-10) return "0";
            double rounded = double.Parse(x.ToString("G10", CultureInfo.InvariantCulture), NumberStyles.Float, CultureInfo.InvariantCulture);
            return rounded.ToString("0.##########", CultureInfo.InvariantCulture);
        }

        /// <summary>
        /// Metres (or radians) per unit for a unit written in a SOLIDWORKS
        /// equation, or 0 when the text is not a unit this knows.
        /// </summary>
        public static double FactorOf(string unit)
        {
            switch ((unit ?? "").Trim().ToLowerInvariant())
            {
                case "mm": return 1e-3;
                case "cm": return 1e-2;
                case "m": return 1;
                case "in": case "\"": return 0.0254;
                case "ft": case "'": return 0.3048;
                case "deg": case "°": return Math.PI / 180;
                case "rad": return 1;
                default: return 0;
            }
        }

        public static bool IsAngleUnit(string unit)
        {
            var u = (unit ?? "").Trim().ToLowerInvariant();
            return u == "deg" || u == "°" || u == "rad";
        }
    }
}
