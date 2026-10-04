using System.Collections.Generic;
using System.Globalization;
using System.Text.RegularExpressions;

namespace Slop.SolidWorks.Core
{
    /// <summary>
    /// One line of the SOLIDWORKS equation manager, e.g.
    /// <c>"D1@Sketch1" = "Width" * 2 'keeps the slot centred</c>.
    /// </summary>
    public sealed class Equation
    {
        /// <summary>Position in the equation manager.</summary>
        public int Index { get; set; }
        public string Text { get; set; }
        /// <summary>Left-hand side without quotes: a global variable ("Width"), a dimension ("D1@Sketch1") or a feature ("Boss-Extrude1").</summary>
        public string Lhs { get; set; }
        /// <summary>Right-hand side as typed, comment removed.</summary>
        public string Rhs { get; set; }
        public string Comment { get; set; }
        /// <summary>Quoted names the right-hand side reads.</summary>
        public List<string> References { get; } = new List<string>();
        public bool IsGlobalVariable { get; set; }
        public bool Suppressed { get; set; }
        /// <summary>Evaluated value as SOLIDWORKS reports it (document units for dimensions).</summary>
        public double Value { get; set; }

        /// <summary>A dimension's full name contains '@' ("D1@Sketch1").</summary>
        public bool DrivesDimension => !IsGlobalVariable && Lhs.Contains("@");
    }

    public static class EquationParser
    {
        private static readonly Regex Quoted = new Regex("\"([^\"]+)\"", RegexOptions.Compiled);
        private static readonly Regex SingleRef = new Regex("^\\s*\"([^\"]+)\"\\s*$", RegexOptions.Compiled);
        private static readonly Regex Literal = new Regex(
            "^\\s*([+-]?(?:\\d+\\.?\\d*|\\.\\d+)(?:[eE][+-]?\\d+)?)\\s*(mm|cm|m|in|ft|deg|rad|°)?\\s*$",
            RegexOptions.Compiled | RegexOptions.IgnoreCase);

        /// <summary>Split an equation at its first unquoted '=' and drop a trailing 'comment. Null if there is no '='.</summary>
        public static Equation Parse(string text)
        {
            if (string.IsNullOrWhiteSpace(text)) return null;
            int eq = IndexOfUnquoted(text, '=', 0);
            if (eq < 0) return null;

            string rhs = text.Substring(eq + 1);
            string comment = null;
            int tick = IndexOfUnquoted(rhs, '\'', 0);
            if (tick >= 0)
            {
                comment = rhs.Substring(tick + 1).Trim();
                rhs = rhs.Substring(0, tick);
            }

            var e = new Equation
            {
                Text = text,
                Lhs = text.Substring(0, eq).Trim().Trim('"').Trim(),
                Rhs = rhs.Trim(),
                Comment = string.IsNullOrEmpty(comment) ? null : comment,
            };
            foreach (Match m in Quoted.Matches(e.Rhs)) e.References.Add(m.Groups[1].Value);
            return e;
        }

        /// <summary>The name, when the right-hand side is exactly one quoted reference: <c>"Width"</c>.</summary>
        public static string SingleReference(string rhs)
        {
            var m = SingleRef.Match(rhs ?? "");
            return m.Success ? m.Groups[1].Value : null;
        }

        /// <summary>
        /// A plain number with an optional unit: "50", "50mm", "2.5 in", "90deg".
        /// <paramref name="unit"/> is lower case, or "" when none was written.
        /// </summary>
        public static bool TryParseLiteral(string rhs, out double number, out string unit)
        {
            number = 0;
            unit = "";
            var m = Literal.Match(rhs ?? "");
            if (!m.Success) return false;
            number = double.Parse(m.Groups[1].Value, NumberStyles.Float, CultureInfo.InvariantCulture);
            unit = m.Groups[2].Success ? m.Groups[2].Value.ToLowerInvariant() : "";
            return true;
        }

        private static int IndexOfUnquoted(string s, char target, int start)
        {
            bool quoted = false;
            for (int i = start; i < s.Length; i++)
            {
                char c = s[i];
                if (c == '"') quoted = !quoted;
                else if (c == target && !quoted) return i;
            }
            return -1;
        }
    }
}
