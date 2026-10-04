using System;
using System.Collections.Generic;
using System.Linq;
using System.Runtime.InteropServices;
using Slop.SolidWorks.Core;
using SolidWorks.Interop.sldworks;
using SolidWorks.Interop.swconst;

namespace Slop.SolidWorks.Extract
{
    /// <summary>
    /// Feature definitions -> IR features, for the MVP set (architecture doc
    /// §14): extrude and cut, revolve, constant-radius fillet, chamfer, Hole
    /// Wizard, shell, linear and circular pattern, mirror, reference plane.
    ///
    /// A reader either writes a feature that means exactly what the SOLIDWORKS
    /// one means, or throws <see cref="UnsupportedException"/> with the reason.
    /// It never writes an approximation: deciding what to do with a feature the
    /// IR cannot express is the translator's job, and it can only do that if
    /// the gap is reported rather than papered over.
    ///
    /// Order inside each reader matters: options are checked first, then the
    /// sub-sketch is emitted, then selections are read, so a feature that turns
    /// out to be unsupported leaves no stray references behind.
    /// </summary>
    internal sealed class FeatureReaders
    {
        private static readonly HashSet<string> SolidOps = new HashSet<string>
        {
            "extrude", "revolve", "fillet", "chamfer", "hole", "shell", "linearPattern", "circularPattern", "mirror",
        };

        private readonly ExtractContext ctx;

        public FeatureReaders(ExtractContext ctx) => this.ctx = ctx;

        // --- emission -------------------------------------------------------------

        /// <summary>Extract a sketch once; later callers (a second feature sharing it) get the same IR sketch.</summary>
        public SketchInfo Sketch(TreeNode node)
        {
            if (ctx.Sketches.TryGetValue(node.Name, out var done)) return done;
            var reader = new SketchReader(ctx, node);
            reader.Read();
            var info = reader.Info;
            var ir = Emit(node, "sketch", reader.Fill, reader.Ext(), reader.Notes);
            info.IrId = ir.Id;
            ctx.Sketches[node.Name] = info;
            var n = ir.Node;
            ctx.Log($"  {ir.Id,-4} {node.Name} -> sketch: {Count(n, "entities")} entities, {Count(n, "constraints")} constraints, {Count(n, "dimensions")} dimensions");
            return info;
        }

        private IrFeature Emit(TreeNode node, string op, Action<JObj> body, JObj ext, IReadOnlyCollection<string> notes = null)
        {
            string id = ctx.FeatureIds.Next("f");
            var n = Ir.Feature(id, node.Name, node.Type, op, node.Suppressed);
            if (notes != null && notes.Count > 0) n.GetObj("fidelity").Add("notes", string.Join("; ", notes));
            body(n);
            if (ext != null) n.Add("ext", new JObj().Add("sw", ext));
            var ir = new IrFeature { Id = id, Op = op, Node = n, Source = node, Solid = SolidOps.Contains(op) };
            ctx.Features.Add(ir);
            ctx.IrByName[node.Name] = ir;
            if (ir.Solid && !node.Suppressed) ctx.AnySolid = true;
            ctx.Topology.Commit();
            ctx.Report.Entry(node, node.Suppressed ? "mapped (suppressed)" : "mapped")
                .Add("ir", id)
                .Add("op", op)
                .Add("notes", notes != null && notes.Count > 0 ? new JArr(notes.Cast<object>()) : null);
            if (op != "sketch") ctx.Log($"  {id,-4} {node.Name} -> {op}{Summary(n)}");
            return ir;
        }

        private static JObj Ext(TreeNode node, object data, Type iface) =>
            new JObj()
                .Add("name", node.Name)
                .Add("type", node.Type)
                .Add("type2", node.Type2 != node.Type ? node.Type2 : null)
                .Add("data", RawDump.Of(data, iface));

        // --- extrude ----------------------------------------------------------------

        public void Extrude(TreeNode node, IExtrudeFeatureData2 d)
        {
            bool boss = d.IsBossFeature();
            if (d.IsThinFeature()) throw new UnsupportedException("thin-wall extrude (no IR form yet)");
            int from = Com.Try(() => d.FromType, 0);
            if (from != (int)swStartConditions_e.swStartSketchPlane) throw new UnsupportedException($"starts from {Name<swStartConditions_e>(from)}, not the sketch plane");
            if (!boss && Com.Try(() => d.FlipSideToCut)) throw new UnsupportedException("cut with 'Flip side to cut' (removes material outside the profile)");
            int ec1 = d.GetEndCondition(true);
            bool two = d.BothDirections;
            int ec2 = two ? d.GetEndCondition(false) : -1;
            RequireEnd(ec1);
            if (two) RequireEnd(ec2);

            var sketch = Sketch(ProfileSketch(node));
            var dims = new DimMatcher(ctx, node);
            int state = ctx.PreState(node);
            JObj end = null, end2 = null;
            void ReadEnds()
            {
                end = EndCondition(d, true, ec1, dims, state, node.Name);
                if (two) end2 = EndCondition(d, false, ec2, dims, state, node.Name);
            }
            if (NeedsReference(ec1) || (two && NeedsReference(ec2))) WithSelections(() => d.AccessSelections(ctx.Doc, null), d.ReleaseSelectionAccess, ReadEnds);
            else ReadEnds();
            if (ec1 == (int)swEndConditions_e.swEndCondThroughAllBoth) end2 = new JObj().Add("type", "throughAll");

            // IR flip is relative to the sketch normal. By convention a boss grows along the normal
            // and a cut goes against it, into the face the sketch sits on (UNVERIFIED for cuts);
            // where the feature's own faces show which side it went, that wins.
            bool reversed = d.ReverseDirection;
            bool flip = boss ? reversed : !reversed;
            string directionFrom = "convention";
            if (!two && ec1 != (int)swEndConditions_e.swEndCondMidPlane)
            {
                var measured = MeasuredFlip(node.Feature, sketch.Transform);
                if (measured.HasValue)
                {
                    if (measured.Value != flip)
                        ctx.Report.Warn(node.Name, $"ReverseDirection={reversed} implies flip={flip}, but the feature's faces lie on the other side; used the faces");
                    flip = measured.Value;
                    directionFrom = "geometry";
                }
            }

            string mode = !boss ? "remove" : ctx.AnySolid && d.Merge ? "add" : "new";
            JObj draft = null;
            if (d.GetDraftWhileExtruding(true)) draft = new JObj().Add("angle", dims.Angle(d.GetDraftAngle(true))).Add("outward", d.GetDraftOutward(true));
            var notes = new List<string>();
            if (two && d.GetDraftWhileExtruding(false)) notes.Add("draft on the second direction is not carried");
            if (Com.Try(() => d.GetContoursCount()) > 0) notes.Add("SOLIDWORKS extrudes selected contours only; the IR profile is the whole sketch");

            var ext = Ext(node, d, typeof(IExtrudeFeatureData2))
                .Add("endCondition", Name<swEndConditions_e>(ec1))
                .Add("endCondition2", two ? Name<swEndConditions_e>(ec2) : null)
                .Add("directionFrom", directionFrom);
            var ir = Emit(node, "extrude", n => n
                .Add("mode", mode)
                .Add("profile", Ir.FeatureOutput(sketch.IrId, "region"))
                .Add("flip", flip)
                .Add("end", end)
                .Add("end2", end2)
                .Add("draft", draft), ext, notes);
            ir.Extrude = new ExtrudeInfo { Sketch = sketch, Flip = flip };
        }

        private static void RequireEnd(int ec)
        {
            switch ((swEndConditions_e)ec)
            {
                case swEndConditions_e.swEndCondUpToBody:
                case swEndConditions_e.swEndCondUpToSelection:
                    throw new UnsupportedException($"end condition {Name<swEndConditions_e>(ec)} has no IR form yet");
            }
        }

        private static bool NeedsReference(int ec) =>
            ec == (int)swEndConditions_e.swEndCondUpToVertex || ec == (int)swEndConditions_e.swEndCondUpToSurface || ec == (int)swEndConditions_e.swEndCondOffsetFromSurface;

        private JObj EndCondition(IExtrudeFeatureData2 d, bool forward, int ec, DimMatcher dims, int state, string where)
        {
            switch ((swEndConditions_e)ec)
            {
                case swEndConditions_e.swEndCondBlind:
                    return new JObj().Add("type", "blind").Add("depth", dims.Length(d.GetDepth(forward)));
                case swEndConditions_e.swEndCondThroughAll:
                case swEndConditions_e.swEndCondThroughAllBoth:
                    return new JObj().Add("type", "throughAll");
                case swEndConditions_e.swEndCondThroughNext:
                case swEndConditions_e.swEndCondUpToNext:
                    return new JObj().Add("type", "upToNext");
                case swEndConditions_e.swEndCondMidPlane:
                    // UNVERIFIED: GetDepth is the total depth, split evenly (as Onshape's SYMMETRIC).
                    return new JObj().Add("type", "midPlane").Add("depth", dims.Length(d.GetDepth(forward)));
                case swEndConditions_e.swEndCondUpToVertex:
                    return new JObj().Add("type", "upToVertex").Add("vertex", EndReference(d, forward, ec, state, where));
                case swEndConditions_e.swEndCondUpToSurface:
                    return new JObj().Add("type", "upToSurface").Add("face", EndReference(d, forward, ec, state, where));
                case swEndConditions_e.swEndCondOffsetFromSurface:
                    // UNVERIFIED: the offset is reported as the depth.
                    return new JObj()
                        .Add("type", "offsetFromSurface")
                        .Add("face", EndReference(d, forward, ec, state, where))
                        .Add("offset", dims.Length(d.GetDepth(forward)))
                        .Add("reverseOffset", d.GetReverseOffset(forward));
                default:
                    throw new UnsupportedException($"end condition {Name<swEndConditions_e>(ec)} has no IR form yet");
            }
        }

        private JObj EndReference(IExtrudeFeatureData2 d, bool forward, int ec, int state, string where)
        {
            int type = 0;
            object target = Com.Try(() => d.GetEndConditionReference(forward, out type))
                ?? (ec == (int)swEndConditions_e.swEndCondUpToVertex ? Com.Try(() => d.GetVertex(forward)) : Com.Try(() => d.GetFace(forward)));
            return ctx.Topology.RefFor(target, state, $"{where} end condition")
                ?? throw new UnsupportedException("its end condition points at geometry the IR cannot name");
        }

        /// <summary>
        /// Which side of the sketch plane the feature went: the area-weighted
        /// side of its faces. Null when it cannot tell (no faces left in the
        /// finished part, or faces balanced on both sides).
        /// </summary>
        private static bool? MeasuredFlip(Feature feature, double[] transform)
        {
            var n = Vec.Normalize(Transforms.Normal(transform));
            var o = Transforms.Origin(transform);
            double sum = 0, weight = 0;
            foreach (var face in Com.Objects(Com.Try(() => feature.GetFaces())).OfType<Face2>())
            {
                var box = Com.Doubles(Com.Try(() => face.GetBox()));
                if (box == null || box.Length < 6) continue;
                double side = Vec.Dot(Vec.Sub(Vec.Mid(Vec.At(box, 0), Vec.At(box, 3)), o), n);
                double area = Com.Try(() => face.GetArea());
                sum += side * area;
                weight += area;
            }
            if (weight <= 0 || Math.Abs(sum / weight) < 1e-9) return null;
            return sum < 0;
        }

        // --- revolve ----------------------------------------------------------------

        public void Revolve(TreeNode node, IRevolveFeatureData2 d)
        {
            if (d.IsThinFeature()) throw new UnsupportedException("thin-wall revolve (no IR form yet)");
            bool boss = d.IsBossFeature();
            int type = d.Type;
            double angle = d.GetRevolutionAngle(true);
            bool full = Num.Near(angle, 2 * Math.PI)
                || type == (int)swRevolveType_e.swRevolveTypeOneDirection360Degrees
                || type == (int)swRevolveType_e.swRevolveTypeMidPlane360Degrees
                || type == (int)swRevolveType_e.swRevolveTypeTwoDirection360Degrees;
            if (!full && type != (int)swRevolveType_e.swRevolveTypeOneDirection)
                throw new UnsupportedException($"{Name<swRevolveType_e>(type)} revolve (the IR revolves one way from the sketch)");

            var sketch = Sketch(ProfileSketch(node));
            var dims = new DimMatcher(ctx, node);
            int state = ctx.PreState(node);
            JObj axis = null;
            WithSelections(() => d.AccessSelections(ctx.Doc, null), d.ReleaseSelectionAccess,
                () => axis = ctx.Topology.RefFor(d.Axis, state, $"{node.Name} axis", sketchEntities: true));
            if (axis == null) throw new UnsupportedException("the axis cannot be named in the IR");

            string mode = !boss ? "remove" : ctx.AnySolid && d.Merge ? "add" : "new";
            Emit(node, "revolve", n => n
                .Add("mode", mode)
                .Add("profile", Ir.FeatureOutput(sketch.IrId, "region"))
                .Add("axis", axis)
                .Add("angle", dims.Angle(full ? 2 * Math.PI : angle))
                .Add("flip", d.ReverseDirection), Ext(node, d, typeof(IRevolveFeatureData2)).Add("revolveType", Name<swRevolveType_e>(type)));
        }

        // --- fillet and chamfer -------------------------------------------------------

        public void Fillet(TreeNode node, ISimpleFilletFeatureData2 d)
        {
            int type = d.Type;
            if (type != (int)swSimpleFilletType_e.swConstRadiusFillet) throw new UnsupportedException($"{Name<swSimpleFilletType_e>(type)} (the IR has constant-radius fillets)");
            if (Com.Try(() => d.AsymmetricFillet)) throw new UnsupportedException("asymmetric fillet");
            int profile = Com.Try(() => d.ConicTypeForCrossSectionProfile, 0);
            if (profile != (int)swFeatureFilletProfileType_e.swFeatureFilletCircular) throw new UnsupportedException($"{Name<swFeatureFilletProfileType_e>(profile)} cross-section");

            var dims = new DimMatcher(ctx, node);
            int state = ctx.PreState(node);
            var refs = new JArr();
            var radii = new List<double>();
            bool multiple = Com.Try(() => d.IsMultipleRadius);
            WithSelections(() => d.AccessSelections(ctx.Doc, null), d.ReleaseSelectionAccess, () =>
            {
                if (Com.Objects(Com.Try(() => d.Features)).Length > 0) throw new UnsupportedException("fillets whole features (the IR selects edges and faces)");
                var items = new List<object>();
                items.AddRange(Com.Objects(Com.Try(() => d.Edges)));
                items.AddRange(Com.Objects(Com.Try(() => d.GetFaces((int)swSimpleFilletWhichFaces_e.swSimpleFilletSingleRadius))));
                foreach (var loop in Com.Objects(Com.Try(() => d.Loops)).OfType<Loop2>()) items.AddRange(Com.Objects(Com.Try(() => loop.GetEdges())));
                if (items.Count == 0) throw new UnsupportedException("its edges could not be read");
                foreach (var item in items)
                {
                    refs.Add(ctx.Topology.RefFor(item, state, $"{node.Name} edge") ?? throw new UnsupportedException("selects geometry the IR cannot name"));
                    if (multiple) radii.Add(Com.Try(() => d.GetRadius(item), d.DefaultRadius));
                }
            });
            if (radii.Any(r => !Num.Near(r, radii[0]))) throw new UnsupportedException("several radii in one fillet (the IR has one radius per fillet)");
            double radius = radii.Count > 0 ? radii[0] : d.DefaultRadius;
            Emit(node, "fillet", n => n
                .Add("radius", dims.Length(radius))
                .Add("tangentPropagation", d.PropagateToTangentFaces)
                .Add("edges", refs), Ext(node, d, typeof(ISimpleFilletFeatureData2)));
        }

        public void Chamfer(TreeNode node, IChamferFeatureData2 d)
        {
            int type = d.Type;
            if (type == (int)swChamferType_e.swChamferVertex) throw new UnsupportedException("vertex chamfer (no IR form yet)");
            var dims = new DimMatcher(ctx, node);
            int state = ctx.PreState(node);
            var refs = new JArr();
            bool flip = false;
            WithSelections(() => d.AccessSelections(ctx.Doc, null), d.ReleaseSelectionAccess, () =>
            {
                var edges = Com.Objects(Com.Try(() => d.Edges));
                var items = new List<object>(edges);
                items.AddRange(Com.Objects(Com.Try(() => d.Faces)));
                foreach (var loop in Com.Objects(Com.Try(() => d.Loops)).OfType<Loop2>()) items.AddRange(Com.Objects(Com.Try(() => loop.GetEdges())));
                if (items.Count == 0) throw new UnsupportedException("its edges could not be read");
                foreach (var item in items)
                    refs.Add(ctx.Topology.RefFor(item, state, $"{node.Name} edge") ?? throw new UnsupportedException("selects geometry the IR cannot name"));
                if (edges.Length > 0) flip = Com.Try(() => d.GetIsFlipped(edges[0]));
            });

            JObj spec;
            bool equal = type == (int)swChamferType_e.swChamferEqualDistance || (type == (int)swChamferType_e.swChamferDistanceDistance && Com.Try(() => d.EqualDistance));
            if (equal)
                spec = new JObj().Add("type", "equalDistance").Add("distance", dims.Length(d.GetEdgeChamferDistance(0)));
            else if (type == (int)swChamferType_e.swChamferDistanceDistance)
                spec = new JObj().Add("type", "twoDistances").Add("distance1", dims.Length(d.GetEdgeChamferDistance(0))).Add("distance2", dims.Length(d.GetEdgeChamferDistance(1))).Add("flip", flip);
            else if (type == (int)swChamferType_e.swChamferAngleDistance)
                spec = new JObj().Add("type", "distanceAngle").Add("distance", dims.Length(d.GetEdgeChamferDistance(0))).Add("angle", dims.Angle(d.EdgeChamferAngle)).Add("flip", flip);
            else throw new UnsupportedException($"chamfer type {Name<swChamferType_e>(type)}");

            Emit(node, "chamfer", n => n
                .Add("spec", spec)
                .Add("edges", refs)
                .Add("tangentPropagation", d.TangentPropagation), Ext(node, d, typeof(IChamferFeatureData2)));
        }

        // --- Hole Wizard ----------------------------------------------------------------

        public void Hole(TreeNode node, IWizardHoleFeatureData2 d)
        {
            int type = d.Type;
            string style = HoleStyle(type, out string why, out bool nearCountersink) ?? throw new UnsupportedException(why);
            var notes = new List<string>();
            if (why != null) notes.Add(why);

            // The sketch that holds the hole centres; a sub-feature of the hole.
            string placement = null;
            WithSelections(() => d.AccessSelections(ctx.Doc, null), d.ReleaseSelectionAccess, () =>
            {
                var first = Com.Objects(d.GetSketchPoints()).OfType<SketchPoint>().FirstOrDefault();
                placement = first != null ? Com.FeatureName(Com.Try(() => first.GetSketch())) : null;
            });
            TreeNode sketchNode = null;
            if (placement != null) ctx.ByName.TryGetValue(placement, out sketchNode);
            sketchNode = sketchNode ?? node.Subs.FirstOrDefault(s => s.Type == "ProfileFeature");
            if (sketchNode == null) throw new UnsupportedException("cannot find the sketch that places the holes");
            if (sketchNode.Type == "3DProfileFeature") throw new UnsupportedException("holes placed by a 3D sketch");
            var sketch = Sketch(sketchNode);

            var dims = new DimMatcher(ctx, node);
            int state = ctx.PreState(node);
            JObj startFace = null, end = null;
            var positions = new JArr();
            int ec = d.EndCondition;
            WithSelections(() => d.AccessSelections(ctx.Doc, null), d.ReleaseSelectionAccess, () =>
            {
                var face = Com.Try(() => d.Face);
                if (face != null) startFace = ctx.Topology.RefFor(face, state, $"{node.Name} start face");
                foreach (var p in Com.Objects(d.GetSketchPoints()).OfType<SketchPoint>())
                {
                    var at = Transforms.ApplyPoint(sketch.Transform, p.X, p.Y, 0);
                    sketch.Points.TryGetValue(Com.PointKey(p), out var arg);
                    positions.Add(new JObj()
                        .Add("kind", "topo")
                        .Add("entity", "vertex")
                        .Add("createdBy", sketch.IrId)
                        .Add("role", arg != null ? "sketch:" + arg : null)
                        .Add("signature", new JObj().Add("point", JArr.Vec(at)))
                        .Add("probe", JArr.Vec(at)));
                }
                end = HoleEnd(d, ec, dims, state, node.Name, tapped: Name<swWzdHoleTypes_e>(type).Contains("Tap"));
            });
            // Without a face selection the hole starts on the placement sketch's face.
            startFace = startFace ?? (ctx.IrByName[sketchNode.Name].Node["plane"] as JObj);
            if (startFace == null || (string)startFace["kind"] != "topo") throw new UnsupportedException("the hole does not start on a face");
            if (positions.Count == 0) throw new UnsupportedException("no hole positions");

            bool tapped = Name<swWzdHoleTypes_e>(type).Contains("Tap");
            // UNVERIFIED: which diameter property each hole type fills in; the first one set wins.
            // A tapped hole is carried as its tap drill (the thread is not modelled), so tap-drill sizes come first.
            double diameter = tapped
                ? First(() => d.TapDrillDiameter, () => d.ThruTapDrillDiameter, () => d.HoleDiameter, () => d.Diameter)
                : style == "simple"
                    ? First(() => d.HoleDiameter, () => d.Diameter, () => d.ThruHoleDiameter)
                    : First(() => d.ThruHoleDiameter, () => d.HoleDiameter, () => d.Diameter);
            if (diameter <= 0) throw new UnsupportedException("no hole diameter could be read");
            JObj counterbore = style == "counterbore"
                ? new JObj().Add("diameter", dims.Length(d.CounterBoreDiameter)).Add("depth", dims.Length(d.CounterBoreDepth))
                : null;
            // A countersunk hole type carries its cone in CounterSink*; a plain or tapped hole with the
            // "near side countersink" option carries it in NearCounterSink*. Both are one cone at the start face.
            JObj countersink = style == "countersink"
                ? nearCountersink
                    ? new JObj().Add("diameter", dims.Length(d.NearCounterSinkDiameter)).Add("angle", dims.Angle(d.NearCounterSinkAngle))
                    : new JObj().Add("diameter", dims.Length(d.CounterSinkDiameter)).Add("angle", dims.Angle(d.CounterSinkAngle))
                : null;
            if (countersink != null && ((JObj)countersink["diameter"])["value"] is double csk && csk <= diameter)
                throw new UnsupportedException($"countersink diameter {((JObj)countersink["diameter"])["expr"]} is not larger than the hole ({dims.Length(diameter)["expr"]}); cannot read the cone");

            // A blind hole may end in a drill point. The property alone does not say whether the bottom is
            // flat or pointed (f7 of the first test part was flat with DrillAngle still set), so count the
            // conical faces coaxial with the hole beyond the one a countersink accounts for.
            JObj drillTip = null;
            if (ec == (int)swEndConditions_e.swEndCondBlind && startFace.GetObj("signature")?["normal"] is JArr axisJ)
            {
                var axis = Vec.Normalize(new[] { (double)axisJ[0], (double)axisJ[1], (double)axisJ[2] });
                var centres = positions.Cast<JObj>().Select(p => (JArr)p.GetObj("signature")["point"]).Select(a => new[] { (double)a[0], (double)a[1], (double)a[2] }).ToList();
                int coaxialCones = CoaxialCones(node.Feature, axis, centres);
                int expected = (countersink != null ? 1 : 0) * positions.Count;
                if (coaxialCones > expected)
                {
                    double tip = Com.Try(() => d.DrillAngle, 0);
                    if (!(tip > 0 && tip < Math.PI)) tip = 118 * Math.PI / 180;
                    drillTip = new JObj().Add("angle", dims.Angle(tip));
                    notes.Add($"ends in a {Units.FormatNumber(tip * 180 / Math.PI)} deg drill point");
                }
            }
            string standard = Com.Try(() => d.Standard);
            JObj standardNode = string.IsNullOrEmpty(standard) ? null : new JObj()
                .Add("name", standard)
                .Add("type", NullIfEmpty(Com.Try(() => d.FastenerType)))
                .Add("size", NullIfEmpty(Com.Try(() => d.FastenerSize)));
            if (tapped) notes.Add("tapped hole: written as its tap drill; threads are not modelled");

            Emit(node, "hole", n => n
                .Add("style", style)
                .Add("positions", positions)
                .Add("startFace", startFace)
                .Add("diameter", dims.Length(diameter))
                .Add("end", end)
                .Add("counterbore", counterbore)
                .Add("countersink", countersink)
                .Add("drillTip", drillTip)
                .Add("standard", standardNode), Ext(node, d, typeof(IWizardHoleFeatureData2)).Add("holeType", Name<swWzdHoleTypes_e>(type)), notes);
        }

        /// <summary>Conical faces of a feature whose axis is the hole axis through one of the centres (countersinks and drill points).</summary>
        private static int CoaxialCones(Feature feature, double[] axis, List<double[]> centres)
        {
            int n = 0;
            foreach (var face in Com.Objects(Com.Try(() => feature.GetFaces())).OfType<Face2>())
            {
                var surface = Com.Try(() => (Surface)face.GetSurface());
                if (surface == null || !Com.Try(() => surface.IsCone())) continue;
                var c = Com.Doubles(Com.Try(() => surface.ConeParams));
                if (c == null || c.Length < 6) continue;
                var coneAxis = Vec.Normalize(Vec.At(c, 3));
                if (!Vec.Parallel(coneAxis, axis, 1e-6)) continue;
                var origin = Vec.At(c, 0);
                bool through = centres.Any(p =>
                {
                    var dvec = Vec.Sub(p, origin);
                    var off = Vec.Sub(dvec, Vec.Scale(axis, Vec.Dot(dvec, axis)));
                    return Vec.Norm(off) < 1e-6;
                });
                if (through) n++;
            }
            return n;
        }

        /// <summary>
        /// simple, counterbore or countersink; null (with the reason) for shapes
        /// the IR cannot hold. A plain or tapped hole with the Hole Wizard's
        /// "near side countersink" option is a countersunk hole geometrically
        /// (<paramref name="nearCountersink"/> says where to read the cone from).
        /// Far-side and middle countersinks have no IR form.
        /// </summary>
        private static string HoleStyle(int type, out string note, out bool nearCountersink)
        {
            note = null;
            nearCountersink = false;
            switch ((swWzdHoleTypes_e)type)
            {
                case swWzdHoleTypes_e.swSimple:
                case swWzdHoleTypes_e.swSimpleDrilled:
                case swWzdHoleTypes_e.swHoleBlind:
                case swWzdHoleTypes_e.swHoleThru:
                case swWzdHoleTypes_e.swTapBlind:
                case swWzdHoleTypes_e.swTapThru:
                case swWzdHoleTypes_e.swTapBlindCosmeticThread:
                case swWzdHoleTypes_e.swTapThruCosmeticThread:
                case swWzdHoleTypes_e.swTapThruThreadThru:
                case swWzdHoleTypes_e.swTapBlindRemoveThread:
                case swWzdHoleTypes_e.swPipeTapBlind:
                case swWzdHoleTypes_e.swPipeTapThru:
                    return "simple";
                case swWzdHoleTypes_e.swCounterBored:
                case swWzdHoleTypes_e.swCounterBoredDrilled:
                case swWzdHoleTypes_e.swCounterBoreBlind:
                case swWzdHoleTypes_e.swCounterBoreThru:
                    return "counterbore";
                case swWzdHoleTypes_e.swCounterSunk:
                case swWzdHoleTypes_e.swCounterSunkDrilled:
                case swWzdHoleTypes_e.swCounterSinkBlind:
                case swWzdHoleTypes_e.swCounterSinkThru:
                case swWzdHoleTypes_e.swCounterSinkBlindWithoutHeadClearance:
                case swWzdHoleTypes_e.swCounterSinkThruWithoutHeadClearance:
                    return "countersink";
                case swWzdHoleTypes_e.swHoleBlindCounterSinkTop:
                case swWzdHoleTypes_e.swHoleThruCounterSinkTop:
                case swWzdHoleTypes_e.swTapBlindCounterSinkTop:
                case swWzdHoleTypes_e.swTapThruCounterSinkTop:
                case swWzdHoleTypes_e.swTapBlindCosmeticThreadCounterSinkTop:
                case swWzdHoleTypes_e.swTapThruCosmeticThreadCounterSinkTop:
                case swWzdHoleTypes_e.swTapThruThreadThruCounterSinkTop:
                case swWzdHoleTypes_e.swPipeTapBlindCounterSinkTop:
                case swWzdHoleTypes_e.swPipeTapThruCounterSinkTop:
                    nearCountersink = true;
                    return "countersink";
                default:
                    note = $"{Name<swWzdHoleTypes_e>(type)} holes (far-side or middle countersinks, tapers, slots, counterdrills) have no IR form yet";
                    return null;
            }
        }

        private JObj HoleEnd(IWizardHoleFeatureData2 d, int ec, DimMatcher dims, int state, string where, bool tapped)
        {
            switch ((swEndConditions_e)ec)
            {
                case swEndConditions_e.swEndCondBlind:
                    // UNVERIFIED: which depth property applies per hole type; the first one set wins.
                    // A tapped hole is carried as its tap drill, so the drill depth comes first for it.
                    return new JObj().Add("type", "blind").Add("depth", dims.Length(tapped
                        ? First(() => d.TapDrillDepth, () => d.HoleDepth, () => d.Depth, () => d.ThruHoleDepth)
                        : First(() => d.HoleDepth, () => d.Depth, () => d.ThruHoleDepth, () => d.TapDrillDepth)));
                case swEndConditions_e.swEndCondThroughAll:
                case swEndConditions_e.swEndCondThroughAllBoth:
                    return new JObj().Add("type", "throughAll");
                case swEndConditions_e.swEndCondThroughNext:
                case swEndConditions_e.swEndCondUpToNext:
                    return new JObj().Add("type", "upToNext");
                case swEndConditions_e.swEndCondUpToSurface:
                case swEndConditions_e.swEndCondUpToVertex:
                {
                    int refType = 0;
                    var target = Com.Try(() => d.GetEndConditionReference(out refType));
                    var r = ctx.Topology.RefFor(target, state, $"{where} end condition") ?? throw new UnsupportedException("its end condition points at geometry the IR cannot name");
                    return ec == (int)swEndConditions_e.swEndCondUpToVertex
                        ? new JObj().Add("type", "upToVertex").Add("vertex", r)
                        : new JObj().Add("type", "upToSurface").Add("face", r);
                }
                default:
                    throw new UnsupportedException($"hole end condition {Name<swEndConditions_e>(ec)} has no IR form yet");
            }
        }

        // --- shell ------------------------------------------------------------------------

        public void Shell(TreeNode node, IShellFeatureData d)
        {
            var dims = new DimMatcher(ctx, node);
            int state = ctx.PreState(node);
            var refs = new JArr();
            WithSelections(() => d.AccessSelections(ctx.Doc, null), d.ReleaseSelectionAccess, () =>
            {
                if (Com.Try(() => d.GetMultipleThicknessFacesCount()) > 0) throw new UnsupportedException("faces with their own thickness (the IR shell is uniform)");
                foreach (var face in Com.Objects(d.FacesRemoved))
                    refs.Add(ctx.Topology.RefFor(face, state, $"{node.Name} removed face") ?? throw new UnsupportedException("removes a face the IR cannot name"));
            });
            Emit(node, "shell", n => n
                .Add("thickness", dims.Length(d.Thickness))
                .Add("removeFaces", refs)
                .Add("outward", d.Direction == 1), Ext(node, d, typeof(IShellFeatureData)));
        }

        // --- patterns and mirror ------------------------------------------------------------

        public void LinearPattern(TreeNode node, ILinearPatternFeatureData d)
        {
            if (Com.Try(() => d.BodyPattern)) throw new UnsupportedException("body pattern (the IR patterns features)");
            if (Com.Try(() => d.VarySketch)) throw new UnsupportedException("'Vary sketch'");
            if (Com.Try(() => d.InstancesToVary)) throw new UnsupportedException("instances to vary");
            if (Com.Try(() => d.D1EndCondition) != (int)swPatternEndCondition_e.swPatternEndCondition_SpacingAndInstances) throw new UnsupportedException("direction 1 runs up to a reference");
            bool second = Com.Try(() => d.IsDirection2Specified()) && d.D2TotalInstances > 1;
            if (second && Com.Try(() => d.D2EndCondition) != (int)swPatternEndCondition_e.swPatternEndCondition_SpacingAndInstances) throw new UnsupportedException("direction 2 runs up to a reference");
            if (second && Com.Try(() => d.D2PatternSeedOnly)) throw new UnsupportedException("'Pattern seed only' in direction 2");

            var dims = new DimMatcher(ctx, node);
            int state = ctx.PreState(node);
            JArr seeds = null;
            JObj dir1 = null, dir2 = null;
            int[] skipped = Array.Empty<int>();
            WithSelections(() => d.AccessSelections(ctx.Doc, null), d.ReleaseSelectionAccess, () =>
            {
                if (Com.Try(() => d.GetPatternFaceCount()) > 0) throw new UnsupportedException("face pattern (the IR patterns features)");
                seeds = Seeds(d.PatternFeatureArray);
                dir1 = Direction(d.D1Axis, state, $"{node.Name} direction 1");
                if (second) dir2 = Direction(d.D2Axis, state, $"{node.Name} direction 2");
                skipped = Com.Ints(Com.Try(() => d.SkippedItemArray));
            });

            int n2 = second ? d.D2TotalInstances : 1;
            // SkippedItemArray holds instance numbers I = n2 * (i - 1) + (j - 1); the IR keeps [i, j], 0-based (UNVERIFIED base).
            var pairs = skipped.Length > 0 ? new JArr(skipped.Select(i => (object)JArr.Of(i / n2, i % n2))) : null;
            Emit(node, "linearPattern", n => n
                .Add("seeds", seeds)
                .Add("direction1", PatternDirection(dir1, d.D1TotalInstances, d.D1Spacing, d.D1ReverseDirection, dims))
                .Add("direction2", second ? PatternDirection(dir2, d.D2TotalInstances, d.D2Spacing, d.D2ReverseDirection, dims) : null)
                .Add("skipped", pairs), Ext(node, d, typeof(ILinearPatternFeatureData)));
        }

        public void CircularPattern(TreeNode node, ICircularPatternFeatureData d)
        {
            if (Com.Try(() => d.BodyPattern)) throw new UnsupportedException("body pattern (the IR patterns features)");
            if (Com.Try(() => d.VarySketch)) throw new UnsupportedException("'Vary sketch'");
            if (Com.Try(() => d.InstancesToVary)) throw new UnsupportedException("instances to vary");
            if (Com.Try(() => d.Direction2) || Com.Try(() => d.Symmetric)) throw new UnsupportedException("second direction (the IR patterns one way)");

            var dims = new DimMatcher(ctx, node);
            int state = ctx.PreState(node);
            JArr seeds = null;
            JObj axis = null;
            int[] skipped = Array.Empty<int>();
            WithSelections(() => d.AccessSelections(ctx.Doc, null), d.ReleaseSelectionAccess, () =>
            {
                if (Com.Try(() => d.GetPatternFaceCount()) > 0) throw new UnsupportedException("face pattern (the IR patterns features)");
                seeds = Seeds(d.PatternFeatureArray);
                object target = d.Axis;
                // A temporary axis is the axis of a cylindrical face; reference the face.
                if (target is RefAxis temp && Com.Try(() => temp.IsTempAxis())) target = Com.Try(() => temp.GetTempAxisReferenceFace()) ?? target;
                axis = ctx.Topology.RefFor(target, state, $"{node.Name} axis");
                skipped = Com.Ints(Com.Try(() => d.SkippedItemArray));
            });
            if (axis == null) throw new UnsupportedException("the axis cannot be named in the IR");

            Emit(node, "circularPattern", n => n
                .Add("seeds", seeds)
                .Add("axis", axis)
                .Add("count", dims.Count(d.TotalInstances))
                // UNVERIFIED: with equal spacing, Spacing is the total angle (as in the dialog).
                .Add("angle", dims.Angle(d.Spacing))
                .Add("equalSpacing", d.EqualSpacing)
                .Add("flip", d.ReverseDirection)
                .Add("skipped", skipped.Length > 0 ? new JArr(skipped.Cast<object>()) : null), Ext(node, d, typeof(ICircularPatternFeatureData)));
        }

        public void Mirror(TreeNode node, IMirrorPatternFeatureData d)
        {
            int state = ctx.PreState(node);
            JArr seeds = null;
            JObj plane = null;
            WithSelections(() => d.AccessSelections(ctx.Doc, null), d.ReleaseSelectionAccess, () =>
            {
                if (Com.Try(() => d.GetMirrorFaceCount()) > 0) throw new UnsupportedException("mirrors faces (the IR mirrors features)");
                seeds = Seeds(d.PatternFeatureArray);
                plane = ctx.Topology.RefFor(d.Plane, state, $"{node.Name} plane");
            });
            if (plane == null) throw new UnsupportedException("the mirror plane cannot be named in the IR");
            Emit(node, "mirror", n => n.Add("seeds", seeds).Add("plane", plane), Ext(node, d, typeof(IMirrorPatternFeatureData)));
        }

        private JArr Seeds(object features)
        {
            var seeds = new JArr();
            foreach (var o in Com.Objects(features))
            {
                string name = Com.FeatureName(o) ?? throw new UnsupportedException("a seed feature cannot be identified");
                string id = ctx.IrId(name) ?? throw new UnsupportedException($"seed \"{name}\" is not in the IR");
                seeds.Add(id);
            }
            if (seeds.Count == 0) throw new UnsupportedException("no seed features (body or face patterns are not supported)");
            return seeds;
        }

        private JObj Direction(object target, int state, string where) =>
            ctx.Topology.RefFor(target, state, where, sketchEntities: true) ?? throw new UnsupportedException("a pattern direction cannot be named in the IR");

        private static JObj PatternDirection(JObj direction, int count, double spacing, bool flip, DimMatcher dims) =>
            new JObj().Add("direction", direction).Add("count", dims.Count(count)).Add("spacing", dims.Length(spacing)).Add("flip", flip);

        // --- reference plane ------------------------------------------------------------

        public void Plane(TreeNode node, IRefPlaneFeatureData d)
        {
            var dims = new DimMatcher(ctx, node);
            int state = ctx.PreState(node);
            JObj definition = null;
            string constraints = null;
            WithSelections(() => d.AccessSelections(ctx.Doc, null), d.ReleaseSelectionAccess, () =>
            {
                var r0 = Com.Try(() => d.Reference[0]);
                var r1 = Com.Try(() => d.Reference[1]);
                var r2 = Com.Try(() => d.Reference[2]);
                int c0 = Com.Try(() => d.Constraint[0]);
                int c1 = Com.Try(() => d.Constraint[1]);
                constraints = $"{c0}/{c1}/{Com.Try(() => d.Constraint[2])}";
                double value = Com.Try(() => d.AngleOrDistance[0]);
                bool flip = Has(c0, swRefPlaneReferenceConstraints_e.swRefPlaneReferenceConstraint_OptionFlip);

                if (r0 != null && r1 == null && r2 == null && Has(c0, swRefPlaneReferenceConstraints_e.swRefPlaneReferenceConstraint_Distance))
                    definition = new JObj().Add("type", "offset").Add("base", PlaneRef(r0, state, node.Name)).Add("distance", dims.Length(value)).Add("flip", flip);
                else if (r0 != null && r1 == null && r2 == null && Has(c0, swRefPlaneReferenceConstraints_e.swRefPlaneReferenceConstraint_Coincident))
                    definition = new JObj().Add("type", "offset").Add("base", PlaneRef(r0, state, node.Name)).Add("distance", ctx.Quantity(0, Ir.Unit.Length)).Add("flip", false);
                else if (r0 != null && r1 != null && r2 == null && (Has(c0, swRefPlaneReferenceConstraints_e.swRefPlaneReferenceConstraint_MidPlane) || Has(c1, swRefPlaneReferenceConstraints_e.swRefPlaneReferenceConstraint_MidPlane)))
                    definition = new JObj().Add("type", "midPlane").Add("a", PlaneRef(r0, state, node.Name)).Add("b", PlaneRef(r1, state, node.Name));
                else if (r0 != null && r1 != null && r2 == null && Has(c0, swRefPlaneReferenceConstraints_e.swRefPlaneReferenceConstraint_Angle))
                    definition = new JObj().Add("type", "angle").Add("base", PlaneRef(r0, state, node.Name)).Add("axis", PlaneRef(r1, state, node.Name)).Add("angle", dims.Angle(value)).Add("flip", flip);
            });
            if (definition == null) throw new UnsupportedException($"plane defined by constraints {constraints} (the IR has offset, mid-plane and angle planes)");
            Emit(node, "plane", n => n.Add("definition", definition), Ext(node, d, typeof(IRefPlaneFeatureData)).Add("constraints", constraints));
        }

        private JObj PlaneRef(object target, int state, string where) =>
            ctx.Topology.RefFor(target, state, $"{where} reference") ?? throw new UnsupportedException("a plane reference cannot be named in the IR");

        private static bool Has(int bits, swRefPlaneReferenceConstraints_e flag) => (bits & (int)flag) != 0;

        // --- shared ---------------------------------------------------------------------

        private TreeNode ProfileSketch(TreeNode node)
        {
            var sketch = node.Subs.FirstOrDefault(s => s.Type == "ProfileFeature");
            if (sketch != null) return sketch;
            if (node.Subs.Any(s => s.Type == "3DProfileFeature")) throw new UnsupportedException("its profile is a 3D sketch");
            throw new UnsupportedException("no profile sketch under the feature (profiles from faces or other features are not supported)");
        }

        /// <summary>
        /// Run <paramref name="read"/> with the feature's selections accessible.
        /// AccessSelections rolls the model back to just before the feature, so
        /// whatever is measured inside is measured in the state the feature saw.
        /// </summary>
        private static void WithSelections(Func<bool> access, Action release, Action read)
        {
            bool ok;
            try
            {
                ok = access();
            }
            catch (COMException e)
            {
                throw new UnsupportedException($"SOLIDWORKS refused access to the feature's selections ({e.Message})");
            }
            if (!ok) throw new UnsupportedException("SOLIDWORKS refused access to the feature's selections");
            try
            {
                read();
            }
            finally
            {
                try
                {
                    release();
                }
                catch (COMException)
                {
                    // nothing more to undo
                }
            }
        }

        private static double First(params Func<double>[] getters)
        {
            foreach (var get in getters)
            {
                double v = Com.Try(get, 0);
                if (v > 0 && !double.IsNaN(v)) return v;
            }
            return 0;
        }

        private static string NullIfEmpty(string s) => string.IsNullOrWhiteSpace(s) ? null : s;

        public static string Name<TEnum>(int value) where TEnum : struct, Enum =>
            Enum.IsDefined(typeof(TEnum), value) ? Enum.GetName(typeof(TEnum), value) : value.ToString();

        private static int Count(JObj n, string key) => (n[key] as JArr)?.Count ?? 0;

        private static string Summary(JObj n)
        {
            switch ((string)n["op"])
            {
                case "extrude":
                    var end = n.GetObj("end");
                    string depth = end?.GetObj("depth")?["expr"] as string;
                    return $" {n["mode"]}, {end?["type"]}{(depth != null ? " " + depth : "")}{((bool)n["flip"] ? ", flipped" : "")}";
                case "fillet":
                    return $" r={n.GetObj("radius")?["expr"]}, {Count(n, "edges")} edge(s)";
                case "hole":
                    return $" {n["style"]} {n.GetObj("diameter")?["expr"]}, {Count(n, "positions")} position(s)";
                default:
                    return "";
            }
        }
    }
}
