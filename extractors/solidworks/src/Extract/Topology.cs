using System;
using System.Collections.Generic;
using System.Linq;
using System.Runtime.InteropServices;
using Slop.SolidWorks.Core;
using SolidWorks.Interop.sldworks;

namespace Slop.SolidWorks.Extract
{
    /// <summary>
    /// Topological references (architecture doc §8). Every face, edge or vertex
    /// a feature selects becomes an IR TopoRef carrying several independent
    /// resolvers:
    ///
    ///  - createdBy: the IR feature whose execution created the entity. The
    ///    Onshape executor scopes candidates by it (qCreatedBy), so it is the
    ///    semantic step of the resolver cascade and must be present.
    ///  - role: where the entity sits on its creating extrude ("capEnd",
    ///    "sideWall:l2", "edge:capEnd|sideWall:l2"), for the translator.
    ///  - srcPersistId: the SOLIDWORKS persistent reference, for re-sync.
    ///  - signature: measured exactly as resolver.ts scores it against
    ///    Onshape's FeatureScript (fs/scripts.ts): outward plane normal and
    ///    offset, area centroid, arc-length midpoint, ...
    ///  - probe: a point on the entity.
    ///
    /// A signature must describe the entity as it was just before the
    /// referencing feature: a sketch face measured on the finished part already
    /// has the hole the next cut makes in it. References read through
    /// AccessSelections are in that state already; the rest (sketch planes,
    /// dimensions to model edges) are re-measured during the rollback pass.
    /// </summary>
    internal sealed class Topology
    {
        private const double Tol = 1e-9;

        private readonly ExtractContext ctx;
        private readonly List<Deferred> committed = new List<Deferred>();
        private readonly List<Deferred> pending = new List<Deferred>();

        private sealed class Deferred
        {
            public JObj Ref;
            public byte[] PersistId;
            public string Entity;
            public int State;
            public string Where;
            /// <summary>Fallback for a sketch face SOLIDWORKS no longer returns: find it by plane among its creator's faces.</summary>
            public string CreatorName;
            public double[] Normal;
            public double Offset;
        }

        public Topology(ExtractContext ctx) => this.ctx = ctx;

        /// <summary>Keep the re-measure requests of a feature that made it into the IR.</summary>
        public void Commit()
        {
            committed.AddRange(pending);
            pending.Clear();
        }

        /// <summary>Drop the requests of a feature that was not emitted.</summary>
        public void Discard() => pending.Clear();

        /// <summary>Rollback states (indices into ExtractContext.Top) with references to re-measure.</summary>
        public IEnumerable<int> States => committed.Select(d => d.State).Where(s => s >= 0).Distinct();

        // --- references ---------------------------------------------------------

        /// <summary>
        /// A Ref for anything a feature or annotation can point at. Returns null
        /// (and records why) when the IR has no way to express it.
        /// <paramref name="state"/> is the rollback state whose geometry the
        /// signature must describe; <paramref name="sketchEntities"/> allows the
        /// sketch-entity form for sketch segments (revolve axes, pattern directions).
        /// </summary>
        public JObj RefFor(object o, int state, string where, bool sketchEntities = false)
        {
            switch (o)
            {
                case null:
                    return Fail(where, "the selection is empty");
                case Face2 f:
                    return Face(f, state, where);
                case Edge e:
                    return Edge(e, state, where);
                case Vertex v:
                    return Vertex(v, state, where);
                case SketchSegment s:
                    return SketchSegment(s, where, sketchEntities);
                case SketchPoint p:
                    return SketchPoint(p, where);
            }
            var plane = Plane(o, where, quiet: true);
            if (plane != null) return plane;
            if (o is RefAxis) return Fail(where, "reference axes have no IR equivalent yet");
            return Fail(where, $"cannot reference a {Describe(o)}");
        }

        public JObj Face(Face2 f, int state, string where)
        {
            string creator = FeatureOf(f);
            var signature = FaceSignature(f, false, out var probe);
            var persist = Persist(f);
            var node = Node("face", CreatedBy(creator, where), FaceRole(f, creator), persist, signature, probe);
            Defer(new Deferred { Ref = node, PersistId = persist, Entity = "face", State = state, Where = where });
            return node;
        }

        public JObj Edge(Edge e, int state, string where)
        {
            string creator = CreatorOfEdge(e);
            var signature = EdgeSignature(e, out var probe);
            var persist = Persist(e);
            var node = Node("edge", CreatedBy(creator, where), EdgeRole(e, creator), persist, signature, probe);
            Defer(new Deferred { Ref = node, PersistId = persist, Entity = "edge", State = state, Where = where });
            return node;
        }

        public JObj Vertex(Vertex v, int state, string where)
        {
            string creator = CreatorOfVertex(v);
            var point = Point(v.GetPoint());
            var persist = Persist(v);
            var node = Node("vertex", CreatedBy(creator, where), null, persist, VertexSignature(point), point);
            Defer(new Deferred { Ref = node, PersistId = persist, Entity = "vertex", State = state, Where = where });
            return node;
        }

        /// <summary>
        /// The face a sketch sits on when SOLIDWORKS no longer returns it (a later
        /// feature consumed it): rebuilt from the sketch plane and the solid
        /// feature among the sketch's parents, then looked up by plane at the
        /// state before the sketch.
        /// </summary>
        public JObj FaceFromPlane(string creatorName, double[] normal, double[] pointOnPlane, int state, string where)
        {
            var n = Vec.Normalize(normal);
            double offset = Vec.Dot(pointOnPlane, n);
            var signature = new JObj().Add("surface", "plane").Add("normal", JArr.Vec(n)).Add("offset", offset);
            var node = Node("face", CreatedBy(creatorName, where), null, null, signature, pointOnPlane);
            Defer(new Deferred { Ref = node, Entity = "face", State = state, Where = where, CreatorName = creatorName, Normal = n, Offset = offset });
            return node;
        }

        /// <summary>A datum plane (FRONT/TOP/RIGHT) or a reference plane feature in the IR.</summary>
        public JObj Plane(object o, string where, bool quiet = false)
        {
            string name = Com.FeatureName(o);
            if (name == null && o is RefPlane rp) name = MatchPlane(rp);
            if (name == null || !ctx.ByName.TryGetValue(name, out var node) || node.Type != "RefPlane")
                return quiet ? null : Fail(where, $"cannot identify the plane ({Describe(o)})");
            if (ctx.DefaultPlanes.TryGetValue(name, out var datum)) return Ir.Datum(datum);
            if (ctx.IrByName.TryGetValue(name, out var ir) && ir.Op == "plane") return Ir.FeatureOutput(ir.Id, "plane");
            return Fail(where, $"plane \"{name}\" is not in the IR (see its own entry in the report)");
        }

        /// <summary>A segment of an extracted sketch: as a sketch-entity ref, or as the model edge the sketch creates.</summary>
        public JObj SketchSegment(SketchSegment s, string where, bool asSketchEntity)
        {
            string sketchName = Com.FeatureName(Com.Try(() => s.GetSketch()));
            if (sketchName == null || !ctx.Sketches.TryGetValue(sketchName, out var info) || !info.Segments.TryGetValue(Com.SegmentKey(s), out var entityId))
                return Fail(where, $"sketch segment {Com.Try(() => s.GetName(), "?")} belongs to a sketch that is not in the IR");
            if (asSketchEntity) return Ir.SketchEntity(info.IrId, entityId);
            var signature = SketchCurveSignature(info, entityId, out var probe);
            return Node("edge", info.IrId, "sketch:" + entityId, null, signature, probe);
        }

        /// <summary>A point of an extracted sketch, as the vertex the sketch creates.</summary>
        public JObj SketchPoint(SketchPoint p, string where)
        {
            string sketchName = Com.FeatureName(Com.Try(() => p.GetSketch()));
            if (sketchName == null || !ctx.Sketches.TryGetValue(sketchName, out var info))
                return Fail(where, "sketch point belongs to a sketch that is not in the IR");
            info.Points.TryGetValue(Com.PointKey(p), out var arg);
            var point = Transforms.ApplyPoint(info.Transform, p.X, p.Y, 0);
            return Node("vertex", info.IrId, arg != null ? "sketch:" + arg : null, null, VertexSignature(point), point);
        }

        // --- the rollback pass --------------------------------------------------

        /// <summary>Re-measure every reference waiting on <paramref name="state"/>. The model must be rolled back to it.</summary>
        public void Resolve(int state)
        {
            foreach (var d in committed.Where(x => x.State == state))
            {
                object entity = null;
                if (d.PersistId != null)
                {
                    int error = 0;
                    entity = Com.Try(() => ctx.Ext.GetObjectByPersistReference3(d.PersistId, out error));
                }
                if (entity == null && d.CreatorName != null) entity = FindPlanarFace(d);
                if (entity == null)
                {
                    ctx.Report.Warn(d.Where, $"could not find the referenced {d.Entity} again before the feature; its signature describes the finished part");
                    continue;
                }
                try
                {
                    Remeasure(d.Ref, entity, d.Entity);
                }
                catch (Exception ex) when (!(ex is OutOfMemoryException))
                {
                    ctx.Report.Warn(d.Where, $"re-measuring the referenced {d.Entity} failed ({ex.Message}); kept the earlier signature");
                }
            }
        }

        private void Remeasure(JObj node, object entity, string kind)
        {
            switch (kind)
            {
                case "face":
                    var f = (Face2)entity;
                    var fs = FaceSignature(f, true, out var fp);
                    node.Add("role", FaceRole(f, FeatureOf(f)) ?? node["role"]);
                    if (node["srcPersistId"] == null) node.Add("srcPersistId", PersistText(Persist(f)));
                    node.Add("signature", fs).Add("probe", fp != null ? JArr.Vec(fp) : null);
                    break;
                case "edge":
                    var e = (Edge)entity;
                    var es = EdgeSignature(e, out var ep);
                    node.Add("role", EdgeRole(e, CreatorOfEdge(e)) ?? node["role"]);
                    node.Add("signature", es).Add("probe", ep != null ? JArr.Vec(ep) : null);
                    break;
                case "vertex":
                    var p = Point(((Vertex)entity).GetPoint());
                    node.Add("signature", VertexSignature(p)).Add("probe", JArr.Vec(p));
                    break;
            }
        }

        private object FindPlanarFace(Deferred d)
        {
            if (!ctx.ByName.TryGetValue(d.CreatorName, out var creator)) return null;
            var matches = new List<Face2>();
            foreach (var o in Com.Objects(Com.Try(() => creator.Feature.GetFaces())))
            {
                if (!(o is Face2 f) || !TryPlane(f, out var n, out var root)) continue;
                if (Vec.Dot(n, d.Normal) > 1 - Tol && Math.Abs(Vec.Dot(root, n) - d.Offset) < Tol) matches.Add(f);
            }
            if (matches.Count > 1) ctx.Report.Warn(d.Where, $"{matches.Count} faces of {d.CreatorName} lie in the sketch plane; cannot tell which one the sketch is on");
            return matches.Count == 1 ? matches[0] : null;
        }

        // --- signatures ---------------------------------------------------------

        /// <summary>
        /// Plane: outward normal and offset (plus the exact area centroid when
        /// <paramref name="withCentroid"/>, which needs the selection set and so
        /// is skipped inside AccessSelections). Cylinder: axis, a point on it,
        /// radius. Always the area.
        /// </summary>
        private JObj FaceSignature(Face2 f, bool withCentroid, out double[] probe)
        {
            var surface = (Surface)f.GetSurface();
            var sig = new JObj();
            if (TryPlane(f, out var n, out var root))
            {
                sig.Add("surface", "plane").Add("normal", JArr.Vec(n)).Add("offset", Vec.Dot(root, n));
                if (withCentroid)
                {
                    var c = PlanarCentroid(f);
                    if (c != null) sig.Add("centroid", JArr.Vec(c));
                }
            }
            else if (surface.IsCylinder())
            {
                var c = Com.Doubles(surface.CylinderParams);
                sig.Add("surface", "cylinder").Add("axis", JArr.Vec(Vec.Normalize(Vec.At(c, 3)))).Add("axisPoint", JArr.Vec(Vec.At(c, 0))).Add("radius", c[6]);
            }
            else if (surface.IsCone())
            {
                var c = Com.Doubles(surface.ConeParams);
                sig.Add("surface", "cone").Add("axis", JArr.Vec(Vec.Normalize(Vec.At(c, 3)))).Add("axisPoint", JArr.Vec(Vec.At(c, 0)));
            }
            else if (surface.IsSphere())
            {
                var c = Com.Doubles(surface.SphereParams);
                sig.Add("surface", "sphere").Add("radius", c[3]);
            }
            else if (surface.IsTorus())
            {
                var c = Com.Doubles(surface.TorusParams);
                sig.Add("surface", "torus").Add("axis", JArr.Vec(Vec.Normalize(Vec.At(c, 3)))).Add("axisPoint", JArr.Vec(Vec.At(c, 0))).Add("radius", c[6]);
            }
            else sig.Add("surface", "bspline");
            sig.Add("area", f.GetArea());
            probe = FaceProbe(f);
            return sig;
        }

        /// <summary>Unit normal pointing out of the material, and a point on the plane.</summary>
        private static bool TryPlane(Face2 f, out double[] normal, out double[] root)
        {
            normal = root = null;
            var surface = (Surface)f.GetSurface();
            if (!surface.IsPlane()) return false;
            var p = Com.Doubles(surface.PlaneParams);
            normal = Vec.Normalize(Vec.At(p, 0));
            // PlaneParams is the surface normal; the face normal is reversed when the face runs against its surface.
            if (!f.FaceInSurfaceSense()) normal = Vec.Scale(normal, -1);
            root = Vec.At(p, 3);
            return true;
        }

        /// <summary>Exact area centroid of a planar face (IModelDocExtension::GetSectionProperties2).</summary>
        private double[] PlanarCentroid(Face2 f)
        {
            try
            {
                ctx.Doc.ClearSelection2(true);
                var r = Com.Doubles(ctx.Ext.GetSectionProperties2(new[] { new DispatchWrapper(f) }));
                if (r == null || r.Length < 5 || r[0] != 0) return null;
                return new[] { r[2], r[3], r[4] };
            }
            catch (COMException)
            {
                return null;
            }
            finally
            {
                ctx.Doc.ClearSelection2(true);
            }
        }

        private static double[] FaceProbe(Face2 f)
        {
            var box = Com.Doubles(Com.Try(() => f.GetBox()));
            if (box == null || box.Length < 6) return null;
            var c = Vec.Mid(Vec.At(box, 0), Vec.At(box, 3));
            var p = Com.Doubles(Com.Try(() => f.GetClosestPointOn(c[0], c[1], c[2])));
            return p != null && p.Length >= 3 ? Vec.At(p, 0) : null;
        }

        /// <summary>
        /// Line: midpoint, length, direction. Circle: radius, centre, length, and
        /// the arc-length midpoint only for open arcs: where a closed circle
        /// "starts" is up to each kernel, so its midpoint would not match.
        /// </summary>
        private static JObj EdgeSignature(Edge e, out double[] probe)
        {
            var curve = (Curve)e.GetCurve();
            var cp = e.GetCurveParams3();
            double u0 = cp.UMinValue, u1 = cp.UMaxValue;
            var start = Point(cp.StartPoint);
            var end = Point(cp.EndPoint);
            double length = curve.GetLength3(u0, u1);
            bool closed = e.GetStartVertex() == null || (start != null && end != null && Vec.Dist(start, end) < Tol);
            var mid = Point(Com.Try(() => curve.Evaluate2((u0 + u1) / 2, 0)));

            var sig = new JObj();
            if (curve.IsLine())
            {
                var lp = Com.Doubles(curve.LineParams);
                var midpoint = start != null && end != null ? Vec.Mid(start, end) : mid;
                sig.Add("curve", "line").Add("midpoint", midpoint != null ? JArr.Vec(midpoint) : null).Add("length", length).Add("direction", JArr.Vec(Vec.Normalize(Vec.At(lp, 3))));
                mid = midpoint ?? mid;
            }
            else if (curve.IsCircle())
            {
                var c = Com.Doubles(curve.CircleParams);
                sig.Add("curve", "circle").Add("radius", c[6]).Add("center", JArr.Vec(Vec.At(c, 0)));
                if (!closed && mid != null) sig.Add("midpoint", JArr.Vec(mid));
                sig.Add("length", length);
            }
            else if (curve.IsEllipse()) sig.Add("curve", "ellipse").Add("length", length);
            else sig.Add("curve", "bspline").Add("length", length);
            probe = mid ?? start;
            return sig;
        }

        private static JObj VertexSignature(double[] point) => new JObj().Add("point", JArr.Vec(point));

        /// <summary>Signature of a sketch curve as the model edge it becomes, from the IR entity.</summary>
        private static JObj SketchCurveSignature(SketchInfo info, string entityId, out double[] probe)
        {
            probe = null;
            var e = info.Entities.OfType<JObj>().FirstOrDefault(x => (string)x["id"] == entityId);
            if (e == null) return null;
            var T = info.Transform;
            double[] P(string key)
            {
                var a = (JArr)e[key];
                return Transforms.ApplyPoint(T, (double)a[0], (double)a[1], 0);
            }
            switch ((string)e["type"])
            {
                case "line":
                    var p0 = P("p0");
                    var p1 = P("p1");
                    probe = Vec.Mid(p0, p1);
                    return new JObj().Add("curve", "line").Add("midpoint", JArr.Vec(probe)).Add("length", Vec.Dist(p0, p1)).Add("direction", JArr.Vec(Vec.Normalize(Vec.Sub(p1, p0))));
                case "circle":
                    var c = P("center");
                    double r = (double)e["r"];
                    probe = Vec.Add(c, Vec.Scale(Vec.Normalize(Transforms.XAxis(T)), r));
                    return new JObj().Add("curve", "circle").Add("radius", r).Add("center", JArr.Vec(c)).Add("length", 2 * Math.PI * r);
                case "arc":
                    var ac = P("center");
                    var a0 = P("p0");
                    double ar = Vec.Dist(a0, ac);
                    probe = a0;
                    return new JObj().Add("curve", "circle").Add("radius", ar).Add("center", JArr.Vec(ac));
                default:
                    return null;
            }
        }

        // --- semantic roles -----------------------------------------------------

        /// <summary>
        /// Role of a face on the extrude that created it: the caps are planar
        /// faces parallel to the sketch, on the sketch plane ("capStart") or
        /// beyond it ("capEnd"); every other face is a side wall, named after
        /// the sketch entity that sweeps it when one does.
        /// </summary>
        private string FaceRole(Face2 f, string creatorName)
        {
            if (creatorName == null || !ctx.IrByName.TryGetValue(creatorName, out var ir) || ir.Extrude == null) return null;
            var T = ir.Extrude.Sketch.Transform;
            var n = Vec.Normalize(Transforms.Normal(T));
            var o = Transforms.Origin(T);
            var dir = ir.Extrude.Flip ? Vec.Scale(n, -1) : n;
            var surface = (Surface)f.GetSurface();

            if (TryPlane(f, out var fn, out var root))
            {
                if (Vec.Parallel(fn, n, 1e-7))
                {
                    double t = Vec.Dot(Vec.Sub(root, o), n);
                    if (Math.Abs(t) < Tol) return "capStart";
                    return t * Vec.Dot(dir, n) > 0 ? "capEnd" : "capStart";
                }
                foreach (var e in Curves(ir.Extrude.Sketch, "line"))
                {
                    var p0 = SketchPoint(T, e, "p0");
                    var p1 = SketchPoint(T, e, "p1");
                    if (Math.Abs(Vec.Dot(Vec.Sub(p0, root), fn)) < Tol && Math.Abs(Vec.Dot(Vec.Sub(p1, root), fn)) < Tol) return "sideWall:" + e["id"];
                }
                return "sideWall";
            }
            if (surface.IsCylinder())
            {
                var c = Com.Doubles(surface.CylinderParams);
                var axisPoint = Vec.At(c, 0);
                var axis = Vec.Normalize(Vec.At(c, 3));
                foreach (var e in Curves(ir.Extrude.Sketch, "circle").Concat(Curves(ir.Extrude.Sketch, "arc")))
                {
                    var center = SketchPoint(T, e, "center");
                    double r = (string)e["type"] == "circle" ? (double)e["r"] : Vec.Dist(SketchPoint(T, e, "p0"), center);
                    var d = Vec.Sub(center, axisPoint);
                    double off = Vec.Norm(Vec.Sub(d, Vec.Scale(axis, Vec.Dot(d, axis))));
                    if (Math.Abs(r - c[6]) < Tol && off < Tol) return "sideWall:" + e["id"];
                }
            }
            return "sideWall";
        }

        /// <summary>"edge:capEnd|sideWall:l2"; faces of another feature carry its id: "edge:sideWall|capEnd:f2".</summary>
        private string EdgeRole(Edge e, string edgeCreator)
        {
            var own = new List<string>();
            var foreign = new List<string>();
            foreach (var o in Com.Objects(Com.Try(() => e.GetTwoAdjacentFaces2())))
            {
                if (!(o is Face2 face)) continue;
                string creator = FeatureOf(face);
                string role = FaceRole(face, creator);
                if (role == null) return null;
                if (creator == edgeCreator) own.Add(role);
                else foreign.Add($"{role}:{ctx.IrId(creator)}");
            }
            if (own.Count + foreign.Count == 0) return null;
            own.Sort(StringComparer.Ordinal);
            foreign.Sort(StringComparer.Ordinal);
            return "edge:" + string.Join("|", own.Concat(foreign));
        }

        private static IEnumerable<JObj> Curves(SketchInfo sketch, string type) =>
            sketch.Entities.OfType<JObj>().Where(e => (string)e["type"] == type && !(bool)e["construction"]);

        private static double[] SketchPoint(double[] T, JObj e, string key)
        {
            var a = (JArr)e[key];
            return Transforms.ApplyPoint(T, (double)a[0], (double)a[1], 0);
        }

        // --- creating features --------------------------------------------------

        private static string FeatureOf(Face2 f) => Com.FeatureName(Com.Try(() => f.GetFeature()));

        /// <summary>
        /// The feature that created an edge is the later of the two that made its
        /// faces: the rim of a hole is created by the cut, not by the block whose
        /// top face it runs along. Same rule Onshape applies for qCreatedBy.
        /// </summary>
        private string CreatorOfEdge(Edge e) => Latest(Com.Objects(Com.Try(() => e.GetTwoAdjacentFaces2())).OfType<Face2>());

        private string CreatorOfVertex(Vertex v)
        {
            var faces = new List<Face2>();
            foreach (var o in Com.Objects(Com.Try(() => v.GetEdges())))
                if (o is Edge e) faces.AddRange(Com.Objects(Com.Try(() => e.GetTwoAdjacentFaces2())).OfType<Face2>());
            return Latest(faces);
        }

        private string Latest(IEnumerable<Face2> faces)
        {
            string best = null;
            int bestIndex = -1;
            foreach (var f in faces)
            {
                string name = FeatureOf(f);
                int i = ctx.TreeIndex(name);
                if (i > bestIndex)
                {
                    bestIndex = i;
                    best = name;
                }
            }
            return best;
        }

        private string CreatedBy(string featureName, string where)
        {
            if (featureName == null)
            {
                ctx.Report.Warn(where, "cannot tell which feature created the referenced entity; the Onshape side needs that to scope its search");
                return null;
            }
            var id = ctx.IrId(featureName);
            if (id == null) ctx.Report.Warn(where, $"references geometry created by \"{featureName}\", which is not in the IR");
            return id;
        }

        // --- plumbing -----------------------------------------------------------

        private void Defer(Deferred d)
        {
            if (d.State < 0) return;
            pending.Add(d);
        }

        private byte[] Persist(object entity) => Com.Try(() => ctx.Ext.GetPersistReference3(entity) as byte[]);

        private static string PersistText(byte[] id) => id != null ? "sw:" + Convert.ToBase64String(id) : null;

        private static JObj Node(string entity, string createdBy, string role, object persist, JObj signature, double[] probe) =>
            new JObj()
                .Add("kind", "topo")
                .Add("entity", entity)
                .Add("createdBy", createdBy)
                .Add("role", role)
                .Add("srcPersistId", persist as string ?? PersistText(persist as byte[]))
                .Add("signature", signature)
                .Add("probe", probe != null ? JArr.Vec(probe) : null);

        private static double[] Point(object v)
        {
            var a = Com.Doubles(v);
            return a != null && a.Length >= 3 ? Vec.At(a, 0) : null;
        }

        private string MatchPlane(RefPlane plane)
        {
            var t = Com.Doubles(Com.Try(() => plane.Transform?.ArrayData));
            if (t == null) return null;
            var n = Vec.At(t, 6);
            var o = Vec.At(t, 9);
            foreach (var node in ctx.ByName.Values)
            {
                if (node.Type != "RefPlane") continue;
                var other = Com.Doubles(Com.Try(() => (node.Feature.GetSpecificFeature2() as RefPlane)?.Transform?.ArrayData));
                if (other == null) continue;
                if (Vec.Parallel(n, Vec.At(other, 6)) && Math.Abs(Vec.Dot(Vec.Sub(Vec.At(other, 9), o), Vec.Normalize(n))) < Tol) return node.Name;
            }
            return null;
        }

        private JObj Fail(string where, string message)
        {
            ctx.Report.Warn(where, message);
            return null;
        }

        private static string Describe(object o)
        {
            if (o == null) return "nothing";
            if (o is RefAxis) return "reference axis";
            if (o is RefPlane) return "reference plane";
            if (o is Feature f) return $"feature \"{Com.Try(() => f.Name, "?")}\" ({Com.Try(() => f.GetTypeName2(), "?")})";
            if (o is Body2) return "body";
            if (o is Loop2) return "loop";
            return "selection of an unknown kind";
        }
    }
}
