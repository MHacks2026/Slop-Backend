using System;
using System.Collections.Generic;
using Slop.SolidWorks.Core;
using SolidWorks.Interop.sldworks;

namespace Slop.SolidWorks.Extract
{
    /// <summary>One node of the FeatureManager tree as walked.</summary>
    internal sealed class TreeNode
    {
        public Feature Feature;
        public string Name;
        /// <summary>IFeature.GetTypeName: the specific type ("Extrusion", "Cut"), which unlike GetTypeName2 never says "ICE".</summary>
        public string Type;
        /// <summary>IFeature.GetTypeName2, kept for the report.</summary>
        public string Type2;
        /// <summary>Position among top-level features; sub-features carry their owner's.</summary>
        public int Index;
        /// <summary>The feature that absorbs this one (a sketch under its extrude), or null at top level.</summary>
        public TreeNode Owner;
        /// <summary>True when this node also appears as some feature's sub-feature.</summary>
        public bool Absorbed;
        /// <summary>Folders, lights, annotations: no geometry, and no place for the rollback bar.</summary>
        public bool Ignored;
        public bool Suppressed;
        public readonly List<TreeNode> Subs = new List<TreeNode>();

        /// <summary>The top-level feature whose rollback position this node shares.</summary>
        public TreeNode Anchor => Owner ?? this;

        public override string ToString() => $"{Name} ({Type})";
    }

    /// <summary>A feature written to the IR.</summary>
    internal sealed class IrFeature
    {
        public string Id;
        public string Op;
        public JObj Node;
        public TreeNode Source;
        /// <summary>Produces solid geometry, so it gets evidence (builder.ts SOLID_OPS).</summary>
        public bool Solid;
        /// <summary>Set for extrudes: what face roles are computed from.</summary>
        public ExtrudeInfo Extrude;
    }

    internal sealed class ExtrudeInfo
    {
        public SketchInfo Sketch;
        public bool Flip;
    }

    /// <summary>What later features need to know about an extracted sketch.</summary>
    internal sealed class SketchInfo
    {
        public string IrId;
        public string Name;
        /// <summary>Sketch-to-model transform, IR Mat4.</summary>
        public double[] Transform;
        /// <summary>Segment key (type:id0:id1) -> IR entity id ("l1").</summary>
        public readonly Dictionary<string, string> Segments = new Dictionary<string, string>();
        /// <summary>Point key (id0:id1) -> IR argument ("l1.start", "c1.center", "p1").</summary>
        public readonly Dictionary<string, string> Points = new Dictionary<string, string>();
        public JArr Entities = new JArr();
    }

    /// <summary>A sketch dimension in the IR, with what Level 3 perturbation needs to drive it in SOLIDWORKS.</summary>
    internal sealed class DimRecord
    {
        public string IrId;
        /// <summary>Name IModelDoc2.Parameter accepts: "D1@Sketch1".</summary>
        public string SwName;
        public string Unit;
        public double Value;
        public bool Driving;
        public bool DrivenByEquation;
    }

    /// <summary>A feature the IR cannot express (yet). Reported, never fatal.</summary>
    internal sealed class UnsupportedException : Exception
    {
        public UnsupportedException(string reason) : base(reason) { }
    }

    /// <summary>
    /// The sidecar report (&lt;part&gt;.extract.json): what happened to every
    /// tree node, and every compromise made on the way, so nothing is dropped
    /// silently (architecture doc §6, "Not transferable" is recorded, not hidden).
    /// </summary>
    internal sealed class Report
    {
        public readonly JArr Features = new JArr();
        public readonly List<string> Warnings = new List<string>();
        private readonly Action<string> log;

        public Report(Action<string> log) => this.log = log ?? (_ => { });

        public JObj Entry(TreeNode node, string status, string reason = null)
        {
            var e = new JObj()
                .Add("name", node.Name)
                .Add("type", node.Type)
                .Add("type2", node.Type2 != node.Type ? node.Type2 : null)
                .Add("status", status)
                .Add("reason", reason);
            Features.Add(e);
            return e;
        }

        public void Warn(string where, string message)
        {
            var line = string.IsNullOrEmpty(where) ? message : $"{where}: {message}";
            Warnings.Add(line);
            log("  warning: " + line);
        }

        public int Count(string status)
        {
            int n = 0;
            foreach (JObj e in Features)
                if ((string)e["status"] == status) n++;
            return n;
        }
    }
}
