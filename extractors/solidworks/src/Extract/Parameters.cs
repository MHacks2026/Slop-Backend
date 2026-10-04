using System;
using System.Collections.Generic;
using System.Linq;
using Slop.SolidWorks.Core;
using SolidWorks.Interop.sldworks;

namespace Slop.SolidWorks.Extract
{
    /// <summary>
    /// Global variables and equations (architecture doc §3 "Equations and
    /// global variables", §7). Global variables become IR Parameters; an
    /// equation that drives a dimension is kept as that dimension's
    /// expression, linked to the Parameter when it is exactly one variable.
    /// </summary>
    internal sealed class Parameters
    {
        private readonly ExtractContext ctx;
        private readonly List<Equation> equations = new List<Equation>();
        private readonly Dictionary<string, Equation> byDimension = new Dictionary<string, Equation>(StringComparer.OrdinalIgnoreCase);
        private readonly Dictionary<string, Equation> globals = new Dictionary<string, Equation>(StringComparer.OrdinalIgnoreCase);
        private readonly Dictionary<string, string> ids = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);

        public Parameters(ExtractContext ctx)
        {
            this.ctx = ctx;
            Read();
        }

        public int Count => equations.Count;

        private void Read()
        {
            var mgr = ctx.Doc.GetEquationMgr();
            if (mgr == null) return;
            int n = mgr.GetCount();
            for (int i = 0; i < n; i++)
            {
                string text = Com.Try(() => mgr.Equation[i]);
                var e = EquationParser.Parse(text);
                if (e == null)
                {
                    ctx.Report.Warn("Equations", $"cannot parse equation {i}: {text}");
                    continue;
                }
                e.Index = i;
                e.IsGlobalVariable = Com.Try(() => mgr.GlobalVariable[i]);
                e.Suppressed = Com.Try(() => mgr.Suppression[i]);
                e.Value = Com.Try(() => mgr.Value[i]);
                equations.Add(e);
                if (e.Suppressed) continue;
                if (e.IsGlobalVariable)
                {
                    globals[e.Lhs] = e;
                    ids[e.Lhs] = ctx.DimensionIds.Unique(Ids.Sanitize(e.Lhs));
                }
                else if (e.DrivesDimension) byDimension[e.Lhs] = e;
                else ctx.Report.Warn("Equations", $"equation \"{e.Lhs}\" = {e.Rhs} drives something other than a dimension (suppression state?); not carried");
            }
        }

        /// <summary>The equation driving dimension "D1@Sketch1", if any.</summary>
        public bool TryDriving(string dimensionName, out Equation equation) => byDimension.TryGetValue(dimensionName, out equation);

        /// <summary>IR Parameter id of global variable <paramref name="name"/>.</summary>
        public string IdOf(string name) => name != null && ids.TryGetValue(name, out var id) ? id : null;

        /// <summary>
        /// IR Parameters for the global variables. Call after every dimension is
        /// read: a variable's unit is inferred from the dimensions it drives,
        /// since SOLIDWORKS global variables are plain numbers unless typed with
        /// a unit.
        /// </summary>
        public JArr ToIr(IReadOnlyDictionary<string, string> dimensionUnits)
        {
            var list = new JArr();
            foreach (var e in globals.Values.OrderBy(x => x.Index))
            {
                string unit = InferUnit(e, dimensionUnits);
                bool literal = EquationParser.TryParseLiteral(e.Rhs, out double number, out string written);
                double value;
                string expression;
                if (literal)
                {
                    if (written.Length > 0)
                    {
                        unit = Units.IsAngleUnit(written) ? Ir.Unit.Angle : Ir.Unit.Length;
                        value = number * Units.FactorOf(written);
                    }
                    else value = ToSi(number, unit);
                    expression = unit == Ir.Unit.Length ? ctx.Units.Length(value) : unit == Ir.Unit.Angle ? ctx.Units.Angle(value) : Units.FormatNumber(number);
                }
                else
                {
                    // An expression of other variables: SOLIDWORKS evaluated it in document units.
                    value = ToSi(e.Value, unit);
                    expression = e.Rhs;
                }
                list.Add(new JObj()
                    .Add("id", ids[e.Lhs])
                    .Add("name", e.Lhs)
                    .Add("scope", "global")
                    .Add("expression", expression)
                    .Add("value", value)
                    .Add("unit", unit)
                    .Add("driven", !literal));
            }
            return list;
        }

        private string InferUnit(Equation global, IReadOnlyDictionary<string, string> dimensionUnits, int depth = 0)
        {
            string found = Ir.Unit.None;
            if (depth > 16) return found; // SOLIDWORKS rejects circular equations; this only guards against bad data
            foreach (var e in byDimension.Values)
            {
                if (!e.References.Any(r => string.Equals(r, global.Lhs, StringComparison.OrdinalIgnoreCase))) continue;
                if (!dimensionUnits.TryGetValue(e.Lhs, out var u)) continue;
                if (u == Ir.Unit.Length) return Ir.Unit.Length;
                if (u == Ir.Unit.Angle) found = Ir.Unit.Angle;
            }
            // A variable used only by other variables inherits their unit.
            if (found == Ir.Unit.None)
            {
                foreach (var other in globals.Values)
                {
                    if (other == global || !other.References.Any(r => string.Equals(r, global.Lhs, StringComparison.OrdinalIgnoreCase))) continue;
                    var u = InferUnit(other, dimensionUnits, depth + 1);
                    if (u != Ir.Unit.None) return u;
                }
            }
            return found;
        }

        private double ToSi(double number, string unit) =>
            unit == Ir.Unit.Length ? number * ctx.Units.MetersPerUnit : unit == Ir.Unit.Angle ? number * ctx.Units.RadiansPerUnit : number;

        /// <summary>Raw equation table for ext.sw / the report.</summary>
        public JArr Raw()
        {
            var a = new JArr();
            foreach (var e in equations)
                a.Add(new JObj().Add("index", e.Index).Add("text", e.Text).Add("global", e.IsGlobalVariable).Add("suppressed", e.Suppressed ? (object)true : null).Add("value", e.Value));
            return a;
        }
    }
}
