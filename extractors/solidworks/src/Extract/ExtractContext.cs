using System;
using System.Collections.Generic;
using Slop.SolidWorks.Core;
using SolidWorks.Interop.sldworks;
using SolidWorks.Interop.swconst;

namespace Slop.SolidWorks.Extract
{
    /// <summary>State shared by the readers during one extraction.</summary>
    internal sealed class ExtractContext
    {
        public SldWorks App;
        public ModelDoc2 Doc;
        public PartDoc Part;
        public ModelDocExtension Ext;
        public Units Units = Units.Millimeters;
        public Report Report;
        public Action<string> Log;
        public Topology Topology;
        public Parameters Parameters;

        /// <summary>Top-level features in tree order.</summary>
        public readonly List<TreeNode> Top = new List<TreeNode>();
        public readonly Dictionary<string, TreeNode> ByName = new Dictionary<string, TreeNode>();
        /// <summary>SOLIDWORKS name of each default plane -> FRONT, TOP or RIGHT.</summary>
        public readonly Dictionary<string, string> DefaultPlanes = new Dictionary<string, string>();

        public readonly List<IrFeature> Features = new List<IrFeature>();
        public readonly Dictionary<string, IrFeature> IrByName = new Dictionary<string, IrFeature>();
        public readonly Dictionary<string, SketchInfo> Sketches = new Dictionary<string, SketchInfo>();
        public readonly List<DimRecord> Dimensions = new List<DimRecord>();
        /// <summary>Unit ("m" or "rad") of every dimension seen, sketch or feature, by SOLIDWORKS name: what global variables' units are inferred from.</summary>
        public readonly Dictionary<string, string> DimensionUnits = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        public readonly IdAllocator FeatureIds = new IdAllocator();
        /// <summary>Dimension and parameter ids share one namespace with nothing else; keep them unique.</summary>
        public readonly IdAllocator DimensionIds = new IdAllocator();
        /// <summary>A solid-producing feature has been emitted (the next boss merges rather than starts the part).</summary>
        public bool AnySolid;

        public int TreeIndex(string featureName) => featureName != null && ByName.TryGetValue(featureName, out var n) ? n.Anchor.Index : -1;

        public string IrId(string featureName) => featureName != null && IrByName.TryGetValue(featureName, out var f) ? f.Id : null;

        /// <summary>
        /// The rollback state just before <paramref name="node"/>: the last
        /// top-level feature before its anchor that is not itself absorbed by a
        /// later feature (the rollback bar cannot sit between a sketch and the
        /// extrude that absorbs it) and is not a folder. -1 when nothing precedes it.
        /// </summary>
        public int PreState(TreeNode node)
        {
            for (int k = node.Anchor.Index - 1; k >= 0; k--)
                if (!Top[k].Absorbed && !Top[k].Ignored) return k;
            return -1;
        }

        /// <summary>
        /// A Quantity for a value read from a feature or sketch dimension:
        /// carries the equation driving it when there is one, so intent like
        /// "Width" * 2 is never flattened to a number (architecture doc §5).
        /// </summary>
        public JObj Quantity(double value, string unit, string dimensionName = null)
        {
            string literal = unit == Ir.Unit.Length ? Units.Length(value) : unit == Ir.Unit.Angle ? Units.Angle(value) : Units.FormatNumber(value);
            if (dimensionName != null && Parameters != null && Parameters.TryDriving(dimensionName, out var eq))
            {
                var single = EquationParser.SingleReference(eq.Rhs);
                string parameter = single != null ? Parameters.IdOf(single) : null;
                return Ir.Quantity(eq.Rhs, value, unit, parameter);
            }
            return Ir.Quantity(literal, value, unit);
        }
    }

    /// <summary>
    /// Pairs the values a feature-data object reports (depth, radius, count)
    /// with the feature's own display dimensions ("D1@Boss-Extrude1"), so the
    /// IR Quantity knows which dimension, and so which equation, drives it.
    /// Matching is by value and kind; ties go to dimension order.
    /// </summary>
    internal sealed class DimMatcher
    {
        private readonly ExtractContext ctx;
        private readonly List<(string Name, double Value, int Kind)> dims = new List<(string, double, int)>();
        private readonly HashSet<int> used = new HashSet<int>();

        public DimMatcher(ExtractContext ctx, TreeNode node)
        {
            this.ctx = ctx;
            foreach (var dd in Com.DisplayDimensions(node.Feature))
            {
                var d = Com.Try(() => dd.GetDimension2(0));
                if (d == null) continue;
                string name = $"{d.Name}@{node.Name}";
                int kind = Com.Try(() => d.GetType(), -1);
                dims.Add((name, Com.SystemValue(d), kind));
                if (kind == (int)swDimensionParamType_e.swDimensionParamTypeDoubleLinear) ctx.DimensionUnits[name] = Ir.Unit.Length;
                else if (kind == (int)swDimensionParamType_e.swDimensionParamTypeDoubleAngular) ctx.DimensionUnits[name] = Ir.Unit.Angle;
            }
        }

        public JObj Length(double value) => Match(value, (int)swDimensionParamType_e.swDimensionParamTypeDoubleLinear, Ir.Unit.Length);

        public JObj Angle(double value) => Match(value, (int)swDimensionParamType_e.swDimensionParamTypeDoubleAngular, Ir.Unit.Angle);

        public JObj Count(int value) => Match(value, (int)swDimensionParamType_e.swDimensionParamTypeInteger, Ir.Unit.None);

        private JObj Match(double value, int kind, string unit)
        {
            for (int i = 0; i < dims.Count; i++)
            {
                if (used.Contains(i) || dims[i].Kind != kind || !Num.Near(dims[i].Value, value)) continue;
                used.Add(i);
                return ctx.Quantity(value, unit, dims[i].Name);
            }
            return ctx.Quantity(value, unit);
        }
    }
}
