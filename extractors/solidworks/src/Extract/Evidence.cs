using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using Slop.SolidWorks.Core;
using SolidWorks.Interop.sldworks;
using SolidWorks.Interop.swconst;

namespace Slop.SolidWorks.Extract
{
    /// <summary>
    /// The evidence layer (architecture doc §9): what the kernel produced, so
    /// the Onshape side can check each rebuilt feature against it.
    /// validate.ts fails a feature on volume and area (relative 1e-6), centre of
    /// mass (1e-6 m) and body count; topology counts and face types are advisory.
    /// </summary>
    internal static class Evidence
    {
        /// <summary>Level 1 evidence for the model in its current rollback state.</summary>
        public static JObj Measure(ExtractContext ctx)
        {
            var bodies = Com.Objects(ctx.Part.GetBodies2((int)swBodyType_e.swSolidBody, false)).OfType<Body2>().ToList();
            double volume = 0, area = 0;
            var moment = new double[3];
            int faces = 0, edges = 0, vertices = 0;
            var types = new SortedDictionary<string, int>(StringComparer.Ordinal);
            double[] min = null, max = null;

            foreach (var body in bodies)
            {
                var mp = Com.Doubles(body.GetMassProperties(1.0)); // [cx, cy, cz, volume, area, mass, ...]
                if (mp != null && mp.Length >= 5)
                {
                    volume += mp[3];
                    area += mp[4];
                    for (int k = 0; k < 3; k++) moment[k] += mp[k] * mp[3];
                }
                faces += body.GetFaceCount();
                edges += body.GetEdgeCount();
                vertices += body.GetVertexCount();
                foreach (var face in Com.Objects(body.GetFaces()).OfType<Face2>())
                {
                    string type = SurfaceType(((Surface)face.GetSurface()).Identity());
                    types.TryGetValue(type, out int n);
                    types[type] = n + 1;
                }
                var box = Com.Doubles(Com.Try(() => body.GetBodyBox()));
                if (box != null && box.Length >= 6)
                {
                    min = min == null ? Vec.At(box, 0) : Pick(min, Vec.At(box, 0), Math.Min);
                    max = max == null ? Vec.At(box, 3) : Pick(max, Vec.At(box, 3), Math.Max);
                }
            }
            double[] com = volume > 0 ? Vec.Scale(moment, 1 / volume) : null;

            // The mass-property engine at its highest accuracy gives the totals; the per-body
            // sums above (which no user override can touch) are the cross-check.
            var precise = Precise(ctx);
            if (precise != null && bodies.Count > 0)
            {
                if (!Num.Near(precise.Item1, volume, 1e-6) || !Num.Near(precise.Item2, area, 1e-6))
                    ctx.Report.Warn("evidence", $"mass properties disagree: volume {precise.Item1:G9} vs {volume:G9} summed over bodies; used the higher-accuracy value");
                volume = precise.Item1;
                area = precise.Item2;
                if (com != null && precise.Item3 != null)
                {
                    if (Vec.Dist(com, precise.Item3) <= 1e-6) com = precise.Item3;
                    else ctx.Report.Warn("evidence", "the part's centre of mass differs from its bodies' (a mass-property override?); used the bodies'");
                }
            }

            var faceTypes = new JObj();
            foreach (var kv in types) faceTypes.Add(kv.Key, kv.Value);
            return new JObj()
                .Add("bodyCount", bodies.Count)
                .Add("volume", volume)
                .Add("area", area)
                .Add("centerOfMass", com != null ? JArr.Vec(com) : null)
                .Add("bbox", min != null ? new JObj().Add("min", JArr.Vec(min)).Add("max", JArr.Vec(max)) : null)
                .Add("faceCount", faces)
                .Add("edgeCount", edges)
                .Add("vertexCount", vertices)
                .Add("faceTypes", faceTypes);
        }

        /// <summary>(volume, area, centre of mass) from IMassProperty2 at the higher accuracy level, or null.</summary>
        private static Tuple<double, double, double[]> Precise(ExtractContext ctx)
        {
            try
            {
                if (!(ctx.Ext.CreateMassProperty2() is MassProperty2 mp)) return null;
                mp.UseSystemUnits = true;
                mp.IncludeHiddenBodiesOrComponents = true;
                mp.AccuracyLevel = (int)swMassPropertyAccuracyLevel_e.swMassPropertyAccuracyLevel_Higher;
                mp.Recalculate();
                var c = Com.Doubles(mp.CenterOfMass);
                return Tuple.Create(mp.Volume, mp.SurfaceArea, c != null && c.Length >= 3 ? Vec.At(c, 0) : null);
            }
            catch (Exception)
            {
                return null;
            }
        }

        /// <summary>
        /// Surface type names as the Onshape side reports them: fs/topology.ts
        /// lower-cases FeatureScript's SurfaceType (PLANE, CYLINDER, CONE, SPHERE,
        /// TORUS, SPUN, SWEPT, OTHER), so the advisory face-type comparison in
        /// validate.ts only lines up when SOLIDWORKS kinds use the same words.
        /// </summary>
        private static string SurfaceType(int identity)
        {
            switch ((swSurfaceTypes_e)identity)
            {
                case swSurfaceTypes_e.PLANE_TYPE: return "plane";
                case swSurfaceTypes_e.CYLINDER_TYPE: return "cylinder";
                case swSurfaceTypes_e.CONE_TYPE: return "cone";
                case swSurfaceTypes_e.SPHERE_TYPE: return "sphere";
                case swSurfaceTypes_e.TORUS_TYPE: return "torus";
                case swSurfaceTypes_e.EXTRU_TYPE: return "swept";
                case swSurfaceTypes_e.SREV_TYPE: return "spun";
                default: return "other"; // B-surfaces and anything else: Onshape reports these as OTHER
            }
        }

        private static double[] Pick(double[] a, double[] b, Func<double, double, double> f) => new[] { f(a[0], b[0]), f(a[1], b[1]), f(a[2], b[2]) };

        /// <summary>
        /// Level 3 source evidence (architecture doc §9, "Behavior"): change one
        /// driving sketch dimension at a time by <paramref name="step"/>, rebuild,
        /// measure, put it back. The Onshape side applies the same change and
        /// compares; a reference resolved by position instead of intent passes
        /// Level 1 and fails here. Changes that break the source are skipped,
        /// as the doc prescribes.
        /// </summary>
        public static JArr Behavior(ExtractContext ctx, int limit, double step, JObj nominal)
        {
            var results = new JArr();
            var candidates = ctx.Dimensions
                .Where(d => d.Driving && !d.DrivenByEquation && Math.Abs(d.Value) > 1e-9)
                .Take(limit)
                .ToList();
            foreach (var dim in candidates)
            {
                var dimension = Com.Try(() => ctx.Doc.Parameter(dim.SwName) as Dimension);
                if (dimension == null)
                {
                    ctx.Report.Warn("behavior", $"cannot find dimension {dim.SwName} to change it");
                    continue;
                }
                double original = Com.SystemValue(dimension);
                string expression = dim.Unit == Ir.Unit.Angle ? ctx.Units.Angle(original * (1 + step)) : ctx.Units.Length(original * (1 + step));
                // Use exactly the value the expression says, so Onshape applies the same number.
                double changed = ValueOf(expression);
                try
                {
                    int status = dimension.SetSystemValue3(changed, (int)swSetValueInConfiguration_e.swSetValue_InThisConfiguration, null);
                    if (status != (int)swSetValueReturnStatus_e.swSetValue_Successful)
                    {
                        ctx.Report.Warn("behavior", $"SOLIDWORKS refused {dim.SwName} = {expression} ({FeatureReaders.Name<swSetValueReturnStatus_e>(status)})");
                        continue;
                    }
                    bool rebuilt = ctx.Doc.EditRebuild3();
                    var broken = FeaturesInError(ctx);
                    if (!rebuilt || broken.Count > 0)
                    {
                        ctx.Report.Warn("behavior", $"{dim.SwName} = {expression} breaks the source model ({string.Join(", ", broken.DefaultIfEmpty("rebuild failed"))}); skipped");
                        continue;
                    }
                    var evidence = Measure(ctx);
                    results.Add(new JObj()
                        .Add("target", dim.IrId)
                        .Add("expression", expression)
                        .Add("expectation", Expectation(ctx, dim, original, expression, nominal, evidence))
                        .Add("evidence", evidence));
                    ctx.Log($"  {dim.IrId} = {expression}: volume {Change(nominal, evidence)}");
                }
                catch (Exception e) when (!(e is OutOfMemoryException))
                {
                    ctx.Report.Warn("behavior", $"{dim.SwName} = {expression} could not be measured ({e.GetType().Name}: {e.Message}); skipped");
                }
                finally
                {
                    dimension.SetSystemValue3(original, (int)swSetValueInConfiguration_e.swSetValue_InThisConfiguration, null);
                    ctx.Doc.EditRebuild3();
                }
            }

            var restored = Measure(ctx);
            if (nominal != null && !Num.Near((double)restored["volume"], (double)nominal["volume"], 1e-9))
                ctx.Report.Warn("behavior", "the model did not return to its original volume after the changes were undone; check the part before saving it");
            return results;
        }

        private static List<string> FeaturesInError(ExtractContext ctx)
        {
            var broken = new List<string>();
            foreach (var node in ctx.Top)
            {
                bool warning = false;
                int code = Com.Try(() => node.Feature.GetErrorCode2(out warning));
                if (code != (int)swFeatureError_e.swFeatureErrorNone && !warning) broken.Add(node.Name);
            }
            return broken;
        }

        private static double ValueOf(string literal)
        {
            var parts = literal.Split(' ');
            return double.Parse(parts[0], NumberStyles.Float, CultureInfo.InvariantCulture) * Units.FactorOf(parts[1]);
        }

        private static string Expectation(ExtractContext ctx, DimRecord dim, double original, string expression, JObj nominal, JObj evidence)
        {
            string from = dim.Unit == Ir.Unit.Angle ? ctx.Units.Angle(original) : ctx.Units.Length(original);
            return $"measured in SOLIDWORKS: {dim.SwName} {from} -> {expression} rebuilds with volume {Change(nominal, evidence)}";
        }

        private static string Change(JObj before, JObj after)
        {
            if (before == null) return "measured";
            double v0 = (double)before["volume"], v1 = (double)after["volume"];
            if (v0 == 0) return "measured";
            double pct = (v1 - v0) / v0 * 100;
            return Math.Abs(pct) < 1e-9 ? "unchanged" : pct.ToString("+0.###;-0.###", CultureInfo.InvariantCulture) + "%";
        }
    }
}
