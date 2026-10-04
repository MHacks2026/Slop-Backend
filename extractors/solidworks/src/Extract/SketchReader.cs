using System;
using System.Collections.Generic;
using System.Linq;
using Slop.SolidWorks.Core;
using SolidWorks.Interop.sldworks;
using SolidWorks.Interop.swconst;

namespace Slop.SolidWorks.Extract
{
    /// <summary>
    /// One 2D sketch (architecture doc §3 "What can be extracted": sketch
    /// geometry, plane and placement, relations, dimensions).
    ///
    /// Coordinates are SOLIDWORKS sketch coordinates in metres, and the
    /// sketch-to-model transform is stored explicitly: the Onshape side maps
    /// through it rather than assuming how a plane orients a sketch
    /// (compose.ts, open question 2).
    /// </summary>
    internal sealed class SketchReader
    {
        private readonly ExtractContext ctx;
        private readonly TreeNode node;
        private readonly Sketch sketch;
        private readonly SketchInfo info = new SketchInfo();
        private readonly IdAllocator entityIds = new IdAllocator();
        private readonly JArr constraints = new JArr();
        private readonly HashSet<string> constraintKeys = new HashSet<string>();
        private readonly JArr dimensions = new JArr();
        private readonly List<string> notes = new List<string>();
        private readonly Dictionary<string, List<string>> pointUses = new Dictionary<string, List<string>>();
        private readonly int state;
        private JObj plane;

        public SketchReader(ExtractContext ctx, TreeNode node)
        {
            this.ctx = ctx;
            this.node = node;
            sketch = node.Feature.GetSpecificFeature2() as Sketch ?? throw new UnsupportedException("no sketch data behind the feature");
            if (sketch.Is3D()) throw new UnsupportedException("3D sketch (Onshape sketches are planar)");
            info.Name = node.Name;
            state = ctx.PreState(node);
        }

        public SketchInfo Info => info;

        /// <summary>What the IR cannot carry from this sketch; becomes fidelity notes.</summary>
        public IReadOnlyList<string> Notes => notes;

        public void Read()
        {
            var modelToSketch = sketch.ModelToSketchTransform;
            var sw = Com.Doubles((modelToSketch.Inverse() as MathTransform)?.ArrayData)
                ?? throw new UnsupportedException("SOLIDWORKS returned no sketch transform");
            if (Math.Abs(sw[12] - 1) > 1e-9) notes.Add($"sketch transform carries a scale of {sw[12]}");
            info.Transform = Transforms.ToIrMat4(sw);

            plane = ReadPlane() ?? throw new UnsupportedException("cannot tell which plane or face the sketch is on");

            foreach (var o in Com.Objects(sketch.GetSketchSegments()))
                if (o is SketchSegment s) ReadSegment(s);
            ReadUserPoints();
            ConnectSharedPoints();
            foreach (var o in Com.Objects(sketch.RelationManager?.GetRelations((int)swSketchRelationFilterType_e.swAll)))
                if (o is SketchRelation r) ReadRelation(r);
            foreach (var dd in Com.DisplayDimensions(node.Feature))
                ReadDimension(dd);
        }

        public void Fill(JObj n) =>
            n.Add("plane", plane)
                .Add("transform", JArr.Vec(info.Transform))
                .Add("entities", info.Entities)
                .Add("constraints", constraints)
                .Add("dimensions", dimensions);

        public JObj Ext()
        {
            int status = Com.Try(() => sketch.GetConstrainedStatus(), 0);
            return new JObj()
                .Add("name", node.Name)
                .Add("type", node.Type)
                .Add("constrainedStatus", Enum.IsDefined(typeof(swConstrainedStatus_e), status) ? ((swConstrainedStatus_e)status).ToString() : status.ToString())
                .Add("unmapped", notes.Count > 0 ? new JArr(notes.Cast<object>()) : null);
        }

        // --- plane --------------------------------------------------------------

        private JObj ReadPlane()
        {
            int type = 0;
            object entity = Com.Try(() => sketch.GetReferenceEntity(ref type));
            if (entity != null && type == (int)swSelectType_e.swSelDATUMPLANES) return ctx.Topology.Plane(entity, node.Name);
            if (entity is Face2 face) return ctx.Topology.Face(face, state, $"{node.Name} plane");

            // GetReferenceEntity returns nothing when a later feature consumed the face. The
            // parents still name the plane or the solid feature whose face it was.
            string solid = null;
            foreach (var o in Com.Objects(Com.Try(() => node.Feature.GetParents())))
            {
                string name = Com.FeatureName(o);
                if (name == null || !ctx.ByName.TryGetValue(name, out var parent)) continue;
                if (parent.Type == "RefPlane") return ctx.Topology.Plane(parent.Feature, node.Name);
                if (ctx.IrByName.TryGetValue(name, out var ir) && ir.Solid && (solid == null || ctx.TreeIndex(name) > ctx.TreeIndex(solid))) solid = name;
            }
            if (solid == null) return null;
            notes.Add($"sketch face reconstructed from the sketch plane and parent \"{solid}\"");
            return ctx.Topology.FaceFromPlane(solid, Transforms.Normal(info.Transform), Transforms.Origin(info.Transform), state, $"{node.Name} plane");
        }

        // --- entities -------------------------------------------------------------

        private void ReadSegment(SketchSegment s)
        {
            int type = s.GetType();
            bool construction = Com.Try(() => s.ConstructionGeometry);
            string src = Com.Try(() => s.GetName());
            string key = Com.SegmentKey(s);
            JObj e;
            switch ((swSketchSegments_e)type)
            {
                case swSketchSegments_e.swSketchLINE:
                {
                    var line = (SketchLine)s;
                    var a = (SketchPoint)line.GetStartPoint2();
                    var b = (SketchPoint)line.GetEndPoint2();
                    string id = entityIds.Next("l");
                    e = Entity(id, "line", construction, src).Add("p0", P(a)).Add("p1", P(b));
                    Use(a, id + ".start");
                    Use(b, id + ".end");
                    break;
                }
                case swSketchSegments_e.swSketchARC:
                {
                    var arc = (SketchArc)s;
                    var c = (SketchPoint)arc.GetCenterPoint2();
                    if (arc.IsCircle() == 1)
                    {
                        string id = entityIds.Next("c");
                        e = Entity(id, "circle", construction, src).Add("center", P(c)).Add("r", arc.GetRadius());
                        Use(c, id + ".center");
                    }
                    else
                    {
                        var a = (SketchPoint)arc.GetStartPoint2();
                        var b = (SketchPoint)arc.GetEndPoint2();
                        string id = entityIds.Next("a");
                        e = Entity(id, "arc", construction, src).Add("center", P(c)).Add("p0", P(a)).Add("p1", P(b)).Add("ccw", ArcDirection(arc, s, c, a, b, src));
                        Use(c, id + ".center");
                        Use(a, id + ".start");
                        Use(b, id + ".end");
                    }
                    break;
                }
                case swSketchSegments_e.swSketchELLIPSE:
                {
                    var ellipse = (SketchEllipse)s;
                    var c = (SketchPoint)ellipse.GetCenterPoint2();
                    var major = (SketchPoint)ellipse.GetMajorPoint2();
                    var minor = (SketchPoint)ellipse.GetMinorPoint2();
                    var a = ellipse.GetStartPoint2() as SketchPoint;
                    var b = ellipse.GetEndPoint2() as SketchPoint;
                    if (a != null && b != null && Com.PointKey(a) != Com.PointKey(b))
                    {
                        notes.Add($"partial ellipse {src} has no IR form; left out");
                        return;
                    }
                    string id = entityIds.Next("e");
                    e = Entity(id, "ellipse", construction, src)
                        .Add("center", P(c))
                        .Add("majorAxis", JArr.Of(major.X - c.X, major.Y - c.Y))
                        .Add("minorRadius", Math.Sqrt((minor.X - c.X) * (minor.X - c.X) + (minor.Y - c.Y) * (minor.Y - c.Y)));
                    Use(c, id + ".center");
                    break;
                }
                default:
                    notes.Add($"{(Enum.IsDefined(typeof(swSketchSegments_e), type) ? ((swSketchSegments_e)type).ToString() : "segment")} {src} is not extracted yet; left out");
                    return;
            }
            info.Entities.Add(e);
            info.Segments[key] = (string)e["id"];
        }

        /// <summary>
        /// Direction of an arc. The segment's length decides it when it can (the
        /// counter-clockwise and clockwise sweeps between the same end points
        /// have different lengths unless the arc is a semicircle), which does not
        /// depend on GetRotationDir conventions; GetRotationDir (1 =
        /// counter-clockwise about the sketch normal) settles semicircles.
        /// </summary>
        private bool ArcDirection(SketchArc arc, SketchSegment s, SketchPoint c, SketchPoint a, SketchPoint b, string src)
        {
            bool api = arc.GetRotationDir() == 1;
            var byLength = Arcs.CcwFromLength(new[] { c.X, c.Y }, new[] { a.X, a.Y }, new[] { b.X, b.Y }, s.GetLength());
            if (byLength.HasValue && byLength.Value != api)
                ctx.Report.Warn(node.Name, $"arc {src}: GetRotationDir says {(api ? "counter-clockwise" : "clockwise")} but its length says otherwise; used the length");
            return byLength ?? api;
        }

        private void ReadUserPoints()
        {
            foreach (var o in Com.Objects(sketch.GetSketchPoints2()))
            {
                if (!(o is SketchPoint p)) continue;
                string key = Com.PointKey(p);
                if (pointUses.ContainsKey(key)) continue; // an end or centre of a segment
                int type = Com.Try(() => p.Type, -1);
                if (type != (int)swSketchPointType_e.swSketchPointType_User && type != (int)swSketchPointType_e.swSketchPointType_Internal) continue;
                string id = entityIds.Next("p");
                info.Entities.Add(Entity(id, "point", false, null).Add("p", P(p)));
                Use(p, id);
            }
        }

        /// <summary>
        /// Connected segments share one SketchPoint in SOLIDWORKS, so no relation
        /// records that they touch. The IR gives every segment its own end points,
        /// so each shared point becomes explicit coincident constraints.
        /// </summary>
        private void ConnectSharedPoints()
        {
            foreach (var uses in pointUses.Values)
                for (int i = 1; i < uses.Count; i++)
                    AddConstraint(Ir.Constraint("coincident", uses[0], uses[i]));
        }

        private void Use(SketchPoint p, string arg)
        {
            string key = Com.PointKey(p);
            if (!pointUses.TryGetValue(key, out var list))
            {
                pointUses[key] = list = new List<string>();
                info.Points[key] = arg;
            }
            list.Add(arg);
        }

        private static JObj Entity(string id, string type, bool construction, string src) =>
            new JObj().Add("id", id).Add("type", type).Add("construction", construction).Add("srcId", src);

        private static JArr P(SketchPoint p) => JArr.Of(p.X, p.Y);

        // --- relations ------------------------------------------------------------

        private void ReadRelation(SketchRelation r)
        {
            int type = r.GetRelationType();
            string name = Enum.IsDefined(typeof(swConstraintType_e), type) ? ((swConstraintType_e)type).ToString().Replace("swConstraintType_", "") : type.ToString();
            if (IsDimensional(type)) return; // carried by the dimension itself

            var entities = Com.Objects(r.GetEntities());
            var externals = new Queue<object>(Com.Objects(Com.Try(() => r.GetDefinitionEntities2())).Where(d => d != null && !IsLocal(d)));
            var args = new List<object>();
            foreach (var entity in entities)
            {
                var arg = Arg(entity, externals, $"relation {name}");
                if (arg == null)
                {
                    notes.Add($"{name} relation references geometry the IR cannot name; left out");
                    return;
                }
                args.Add(arg);
            }

            var mapped = MapRelation(type, args);
            if (mapped == null)
            {
                notes.Add($"{name} relation has no IR equivalent yet; left out");
                return;
            }
            foreach (var c in mapped) AddConstraint(c);
        }

        private static bool IsDimensional(int type)
        {
            switch ((swConstraintType_e)type)
            {
                case swConstraintType_e.swConstraintType_DISTANCE:
                case swConstraintType_e.swConstraintType_ANGLE:
                case swConstraintType_e.swConstraintType_RADIUS:
                case swConstraintType_e.swConstraintType_DIAMETER:
                case swConstraintType_e.swConstraintType_DOUBLEDISTANCE:
                case swConstraintType_e.swConstraintType_ANGLE3P:
                case swConstraintType_e.swConstraintType_ARCLENGTH:
                    return true;
                default:
                    return false;
            }
        }

        /// <summary>SOLIDWORKS relation -> IR constraints (several when the IR needs a combination).</summary>
        private static IEnumerable<JObj> MapRelation(int type, List<object> a)
        {
            switch ((swConstraintType_e)type)
            {
                case swConstraintType_e.swConstraintType_HORIZONTAL:
                case swConstraintType_e.swConstraintType_HORIZPOINTS:
                    return new[] { Ir.Constraint("horizontal", a.ToArray()) };
                case swConstraintType_e.swConstraintType_VERTICAL:
                case swConstraintType_e.swConstraintType_VERTPOINTS:
                    return new[] { Ir.Constraint("vertical", a.ToArray()) };
                case swConstraintType_e.swConstraintType_TANGENT:
                    return Pairwise("tangent", a);
                case swConstraintType_e.swConstraintType_PARALLEL:
                    return Pairwise("parallel", a);
                case swConstraintType_e.swConstraintType_PERPENDICULAR:
                    return Pairwise("perpendicular", a);
                case swConstraintType_e.swConstraintType_COINCIDENT:
                case swConstraintType_e.swConstraintType_MERGEPOINTS:
                    return Pairwise("coincident", a);
                case swConstraintType_e.swConstraintType_CONCENTRIC:
                    return Pairwise("concentric", a);
                case swConstraintType_e.swConstraintType_SAMELENGTH:
                    return Pairwise("equal", a);
                case swConstraintType_e.swConstraintType_COLINEAR:
                    return Pairwise("collinear", a);
                case swConstraintType_e.swConstraintType_CORADIAL:
                    return Pairwise("concentric", a).Concat(Pairwise("equal", a));
                case swConstraintType_e.swConstraintType_FIXED:
                    return a.Select(x => Ir.Constraint("fix", x));
                case swConstraintType_e.swConstraintType_ATMIDDLE:
                    // Point first, then the line it bisects.
                    return a.Count == 2 ? new[] { Ir.Constraint("midpoint", PointFirst(a)) } : null;
                case swConstraintType_e.swConstraintType_SYMMETRIC:
                    return a.Count == 3 ? new[] { Ir.Constraint("symmetric", a[0], a[1], a[2]) } : null;
                case swConstraintType_e.swConstraintType_ATINTERSECT:
                    // A point at the intersection of two curves: on both.
                    return a.Count == 3 ? new[] { Ir.Constraint("coincident", a[0], a[1]), Ir.Constraint("coincident", a[0], a[2]) } : null;
                case swConstraintType_e.swConstraintType_ATPIERCE:
                    return a.Count == 2 ? new[] { Ir.Constraint("pierce", PointFirst(a)) } : null;
                case swConstraintType_e.swConstraintType_USEEDGE:
                    // Convert Entities: the segment lies on a model edge.
                    return a.Count == 2 ? new[] { Ir.Constraint("onEntity", a[0], a[1]) } : null;
                default:
                    return null;
            }
        }

        private static IEnumerable<JObj> Pairwise(string type, List<object> a)
        {
            if (a.Count < 2) return null;
            return Enumerable.Range(1, a.Count - 1).Select(i => Ir.Constraint(type, a[0], a[i]));
        }

        private static object[] PointFirst(List<object> a)
        {
            bool firstIsPoint = a[0] is string s0 && (s0 == "ORIGIN" || s0.Contains(".") || s0.StartsWith("p"));
            return firstIsPoint ? new[] { a[0], a[1] } : new[] { a[1], a[0] };
        }

        private void AddConstraint(JObj c)
        {
            var args = ((JArr)c["args"]).Select(x => x as string ?? Json.Write(x).Trim()).ToList();
            string type = (string)c["type"];
            bool symmetric = type == "coincident" || type == "equal" || type == "parallel" || type == "perpendicular" || type == "tangent" || type == "concentric" || type == "collinear";
            if (symmetric) args.Sort(StringComparer.Ordinal);
            if (constraintKeys.Add(type + "|" + string.Join(",", args))) constraints.Add(c);
        }

        // --- dimensions -----------------------------------------------------------

        private void ReadDimension(DisplayDimension dd)
        {
            var dim = Com.Try(() => dd.GetDimension2(0));
            if (dim == null) return;
            string swName = $"{dim.Name}@{node.Name}";
            int displayType = Com.Try(() => dd.GetType(), 0);
            string type = DimensionType(displayType);
            if (type == null)
            {
                notes.Add($"{swName} is a {(Enum.IsDefined(typeof(swDimensionType_e), displayType) ? ((swDimensionType_e)displayType).ToString() : "dimension")}, which has no IR form yet; left out");
                return;
            }

            var annotation = dd.GetAnnotation() as Annotation;
            var entities = Com.Objects(annotation?.GetAttachedEntities3());
            if (entities.Length == 0 || entities.Length > 2)
            {
                notes.Add($"{swName} is attached to {entities.Length} entities; left out");
                return;
            }
            var args = new List<object>();
            for (int i = 0; i < entities.Length; i++)
            {
                var arg = DimensionArg(entities[i], dim, i, type, swName);
                if (arg == null)
                {
                    notes.Add($"{swName} is attached to geometry the IR cannot name; left out");
                    return;
                }
                args.Add(arg);
            }
            // A horizontal or vertical dimension on one line measures between its end points.
            if ((type == "horizontal" || type == "vertical") && args.Count == 1 && args[0] is string only && only.StartsWith("l") && !only.Contains("."))
                args = new List<object> { only + ".start", only + ".end" };

            int kind = Com.Try(() => dim.GetType(), 0);
            string unit = type == "angle" || kind == (int)swDimensionParamType_e.swDimensionParamTypeDoubleAngular ? Ir.Unit.Angle : Ir.Unit.Length;
            double value = Com.SystemValue(dim);
            int driven = Com.Try(() => dim.DrivenState, 0);
            bool driving = driven == (int)swDimensionDrivenState_e.swDimensionDriving || (driven != (int)swDimensionDrivenState_e.swDimensionDriven && !Com.Try(() => dd.IsReferenceDim()));
            string id = ctx.DimensionIds.Unique(Ids.Sanitize(swName));

            dimensions.Add(new JObj()
                .Add("id", id)
                .Add("type", type)
                .Add("args", new JArr(args))
                .Add("value", ctx.Quantity(value, unit, swName))
                .Add("driving", driving));
            ctx.DimensionUnits[swName] = unit;
            ctx.Dimensions.Add(new DimRecord
            {
                IrId = id,
                SwName = swName,
                Unit = unit,
                Value = value,
                Driving = driving,
                DrivenByEquation = ctx.Parameters.TryDriving(swName, out _),
            });
        }

        private static string DimensionType(int t)
        {
            switch ((swDimensionType_e)t)
            {
                case swDimensionType_e.swLinearDimension: return "distance";
                case swDimensionType_e.swHorLinearDimension: return "horizontal";
                case swDimensionType_e.swVertLinearDimension: return "vertical";
                case swDimensionType_e.swAngularDimension: return "angle";
                case swDimensionType_e.swRadialDimension: return "radius";
                case swDimensionType_e.swDiameterDimension: return "diameter";
                default: return null;
            }
        }

        private object DimensionArg(object entity, Dimension dim, int index, string type, string swName)
        {
            switch (entity)
            {
                case SketchSegment s when SameSketch(s) && info.Segments.TryGetValue(Com.SegmentKey(s), out var id):
                    bool curved = s.GetType() == (int)swSketchSegments_e.swSketchARC || s.GetType() == (int)swSketchSegments_e.swSketchELLIPSE;
                    if (!curved || type == "radius" || type == "diameter" || type == "angle") return id;
                    int condition = Com.Try(() => dim.GetArcEndCondition(index + 1), 0);
                    if (condition == (int)swArcEndCondition_e.swArcEndConditionMin || condition == (int)swArcEndCondition_e.swArcEndConditionMax)
                    {
                        notes.Add($"{swName} measures to the {(condition == (int)swArcEndCondition_e.swArcEndConditionMin ? "near" : "far")} side of {id}, which the IR cannot say");
                        return null;
                    }
                    return id + ".center";
                case SketchPoint p when SameSketch(p) && info.Points.TryGetValue(Com.PointKey(p), out var arg):
                    return arg;
                case SketchPoint p when IsOrigin(p):
                    return "ORIGIN";
            }
            return ctx.Topology.RefFor(entity, state, $"{node.Name} {swName}");
        }

        // --- arguments ------------------------------------------------------------

        /// <summary>A relation argument: a local entity id, ORIGIN, or a Ref to geometry outside the sketch.</summary>
        private object Arg(object entity, Queue<object> externals, string what)
        {
            switch (entity)
            {
                case SketchPoint p when SameSketch(p) && info.Points.TryGetValue(Com.PointKey(p), out var arg):
                    return arg;
                case SketchPoint p when IsOrigin(p):
                    return "ORIGIN";
                case SketchSegment s when SameSketch(s) && info.Segments.TryGetValue(Com.SegmentKey(s), out var id):
                    return id;
            }
            // Outside the sketch. SOLIDWORKS may have projected it into an internal entity;
            // the definition entities name the real thing.
            var target = externals.Count > 0 ? externals.Dequeue() : entity;
            if (target is SketchPoint tp && IsOrigin(tp)) return "ORIGIN";
            return target == null ? null : ctx.Topology.RefFor(target, state, $"{node.Name} {what}");
        }

        private bool IsLocal(object o) =>
            (o is SketchPoint p && SameSketch(p) && info.Points.ContainsKey(Com.PointKey(p)))
            || (o is SketchSegment s && SameSketch(s) && info.Segments.ContainsKey(Com.SegmentKey(s)));

        private bool SameSketch(SketchPoint p) => Com.FeatureName(Com.Try(() => p.GetSketch())) == node.Name;

        private bool SameSketch(SketchSegment s) => Com.FeatureName(Com.Try(() => s.GetSketch())) == node.Name;

        /// <summary>The part origin, as the sketch sees it.</summary>
        private static bool IsOrigin(SketchPoint p)
        {
            if (Com.Try(() => p.Type, -1) == (int)swSketchPointType_e.swSketchPointType_Origin) return true;
            var owner = Com.Try(() => p.GetSketch()) as Feature;
            return owner != null && Com.Try(() => owner.GetTypeName2()) == "OriginProfileFeature";
        }
    }
}
