using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using Slop.SolidWorks.Core;
using SolidWorks.Interop.sldworks;
using SolidWorks.Interop.swconst;

namespace Slop.SolidWorks.Extract
{
    public sealed class ExtractOptions
    {
        /// <summary>Roll back after every solid feature to record Level 1 evidence, and re-measure references.</summary>
        public bool Evidence { get; set; } = true;
        /// <summary>Driving dimensions to perturb for Level 3 evidence (architecture doc §14: up to 10). 0 disables.</summary>
        public int BehaviorLimit { get; set; } = 10;
        /// <summary>Relative change applied to each perturbed dimension.</summary>
        public double BehaviorStep { get; set; } = 0.10;
    }

    public sealed class ExtractResult
    {
        public string IrJson;
        public string ReportJson;
        public int Features;
        public int Unsupported;
        public int Errors;
        public int Warnings;
        public int Behavior;
    }

    /// <summary>
    /// Extracts one part (architecture doc §3) in three passes:
    ///
    ///  1. Definitions, at the end of the tree: walk the FeatureManager tree in
    ///     rollback order and turn each feature into IR.
    ///  2. Rollback: put the rollback bar after each solid feature and record
    ///     evidence (§9 Level 1), and re-measure references taken from the
    ///     finished part at the state their feature saw (§8 step 1).
    ///  3. Behaviour: perturb driving dimensions, rebuild, record (§9 Level 3).
    ///
    /// The document is left as it was found: rollback bar, dimension values.
    /// Nothing is saved.
    /// </summary>
    public sealed class PartExtractor
    {
        private const string ToolVersion = "0.1.0";

        private static readonly HashSet<string> IgnoredTypes = new HashSet<string>(StringComparer.Ordinal)
        {
            "OriginProfileFeature", "DetailCabinet", "Attribute", "Sensor", "AmbientLight", "DirectionLight", "PointLight",
            "SpotLight", "CameraFeature", "MagneticGroundPlane", "GroundPlane", "LiveSection", "TemplateFlatPattern",
            "TemplateSheetMetal", "DimXpertManager", "MBD3DPdfFolder",
        };

        private readonly ExtractContext ctx;
        private readonly string sourcePath;
        private readonly string release;
        private readonly string revision;
        private readonly ExtractOptions options;

        public PartExtractor(SldWorks app, ModelDoc2 doc, string sourcePath, string release, string revision, ExtractOptions options, Action<string> log)
        {
            log = log ?? (_ => { });
            ctx = new ExtractContext { App = app, Doc = doc, Log = log, Report = new Report(log) };
            this.sourcePath = sourcePath;
            this.release = release;
            this.revision = revision;
            this.options = options ?? new ExtractOptions();
        }

        public ExtractResult Run()
        {
            var clock = Stopwatch.StartNew();
            var startedAt = DateTime.UtcNow;
            var doc = ctx.Doc;
            if (doc.GetType() != (int)swDocumentTypes_e.swDocPART) throw new InvalidOperationException("only parts can be extracted (assemblies and drawings are out of the MVP's scope)");
            ctx.Part = (PartDoc)doc;
            ctx.Ext = doc.Extension;
            ctx.Units = Units.FromSolidWorks(
                ctx.Ext.GetUserPreferenceInteger((int)swUserPreferenceIntegerValue_e.swUnitsLinear, (int)swUserPreferenceOption_e.swDetailingNoOptionSpecified),
                ctx.Ext.GetUserPreferenceInteger((int)swUserPreferenceIntegerValue_e.swUnitsAngular, (int)swUserPreferenceOption_e.swDetailingNoOptionSpecified));
            ctx.Topology = new Topology(ctx);
            string configuration = Com.Try(() => (doc.GetActiveConfiguration() as Configuration)?.Name);

            Walk();
            string rolledBackAt = ctx.Top.FirstOrDefault(n => Com.Try(() => n.Feature.IsRolledBack()))?.Name;
            if (rolledBackAt != null)
            {
                ctx.Log($"the rollback bar is above {rolledBackAt}; extracting the whole tree and putting the bar back afterwards");
                RollTo(swMoveRollbackBarTo_e.swMoveRollbackBarToEnd, "");
            }
            if (ctx.Ext.NeedsRebuild2 != 0) doc.EditRebuild3();
            FindDefaultPlanes();
            ctx.Parameters = new Parameters(ctx);

            // Pass 1: definitions.
            ctx.Log($"reading {ctx.Top.Count} tree nodes");
            var readers = new FeatureReaders(ctx);
            var ignored = new JArr();
            foreach (var node in ctx.Top)
            {
                if (node.Absorbed) continue; // extracted with the feature that owns it
                Extract(node, readers, ignored);
            }
            var parameters = ctx.Parameters.ToIr(ctx.DimensionUnits);

            // Pass 2: rollback. Pass 3: behaviour.
            int states = 0;
            JArr behavior = null;
            try
            {
                if (options.Evidence) states = RollbackPass();
                if (options.Evidence && options.BehaviorLimit > 0 && ctx.Dimensions.Count > 0)
                {
                    ctx.Log("recording behaviour under dimension changes");
                    var nominal = ctx.Features.LastOrDefault(f => f.Node.Has("evidence"))?.Node.GetObj("evidence");
                    behavior = Evidence.Behavior(ctx, options.BehaviorLimit, options.BehaviorStep, nominal);
                }
            }
            finally
            {
                if (rolledBackAt != null) RollTo(swMoveRollbackBarTo_e.swMoveRollbackBarToBeforeFeature, rolledBackAt);
            }

            string fileName = !string.IsNullOrEmpty(sourcePath) ? Path.GetFileName(sourcePath) : doc.GetTitle();
            var ir = new JObj()
                .Add("irVersion", Ir.Version)
                .Add("source", new JObj()
                    .Add("cad", "solidworks")
                    .Add("version", release)
                    .Add("fileName", fileName)
                    .Add("fileHash", Hash(sourcePath))
                    .Add("extractedAt", startedAt.ToString("yyyy-MM-ddTHH:mm:ssZ")))
                .Add("customProperties", CustomProperties(configuration))
                .Add("parameters", parameters)
                .Add("partStudio", new JObj()
                    .Add("id", "ps1")
                    .Add("name", Path.GetFileNameWithoutExtension(fileName))
                    .Add("features", new JArr(ctx.Features.Select(f => (object)f.Node))))
                .Add("behaviorEvidence", behavior != null && behavior.Count > 0 ? behavior : null);

            var result = new ExtractResult
            {
                Features = ctx.Features.Count,
                Unsupported = ctx.Report.Count("unsupported"),
                Errors = ctx.Report.Count("error"),
                Warnings = ctx.Report.Warnings.Count,
                Behavior = behavior?.Count ?? 0,
            };
            var report = new JObj()
                .Add("tool", "slop-solidworks-extractor")
                .Add("toolVersion", ToolVersion)
                .Add("solidworks", new JObj().Add("release", release).Add("revision", revision))
                .Add("file", sourcePath)
                .Add("configuration", configuration)
                .Add("units", new JObj().Add("length", ctx.Units.LengthSymbol).Add("angle", ctx.Units.AngleSymbol))
                .Add("startedAt", startedAt.ToString("yyyy-MM-ddTHH:mm:ssZ"))
                .Add("seconds", Math.Round(clock.Elapsed.TotalSeconds, 1))
                .Add("summary", new JObj()
                    .Add("irFeatures", result.Features)
                    .Add("unsupported", result.Unsupported)
                    .Add("errors", result.Errors)
                    .Add("warnings", result.Warnings)
                    .Add("evidenceStates", states)
                    .Add("behaviorEvidence", result.Behavior))
                .Add("features", ctx.Report.Features)
                .Add("ignored", ignored)
                .Add("warnings", new JArr(ctx.Report.Warnings.Cast<object>()))
                .Add("equations", ctx.Parameters.Count > 0 ? ctx.Parameters.Raw() : null);

            result.IrJson = Json.Write(ir);
            result.ReportJson = Json.Write(report);
            return result;
        }

        // --- tree -------------------------------------------------------------------

        /// <summary>
        /// Top-level features in rollback order, then each one's sub-features.
        /// A sketch absorbed by an extrude may or may not also be returned at top
        /// level; either way it ends up as one node, owned by its extrude.
        /// </summary>
        private void Walk()
        {
            var seen = new HashSet<string>(StringComparer.Ordinal);
            void AddTop(Feature f)
            {
                string name = f.Name;
                if (!seen.Add(name)) return;
                var node = NewNode(f, ctx.Top.Count, null);
                ctx.Top.Add(node);
                ctx.ByName[name] = node;
            }
            for (var f = ctx.Doc.FirstFeature() as Feature; f != null; f = f.GetNextFeature() as Feature)
            {
                AddTop(f);
                if (Com.Try(() => f.GetTypeName2()) == "FtrFolder")
                    foreach (var s in Com.SubFeatures(f)) AddTop(s); // features grouped in a user folder
            }
            foreach (var node in ctx.Top.ToList())
            {
                if (IsIgnored(node.Type) || node.Type == "FtrFolder") continue;
                foreach (var s in Com.SubFeatures(node.Feature))
                {
                    string name = s.Name;
                    if (ctx.ByName.TryGetValue(name, out var existing))
                    {
                        if (existing != node && existing.Owner == null)
                        {
                            existing.Owner = node;
                            existing.Absorbed = true;
                        }
                        node.Subs.Add(existing);
                        continue;
                    }
                    var sub = NewNode(s, node.Index, node);
                    ctx.ByName[name] = sub;
                    node.Subs.Add(sub);
                }
            }
        }

        private static TreeNode NewNode(Feature f, int index, TreeNode owner)
        {
            var node = new TreeNode
            {
                Feature = f,
                Name = f.Name,
                Type = Com.Try(() => f.GetTypeName(), "?"),
                Type2 = Com.Try(() => f.GetTypeName2(), "?"),
                Index = index,
                Owner = owner,
                Suppressed = Com.IsSuppressed(f),
            };
            node.Ignored = IsIgnored(node.Type) || node.Type == "OriginProfileFeature";
            return node;
        }

        private static bool IsIgnored(string type) => IgnoredTypes.Contains(type) || type.EndsWith("Folder", StringComparison.Ordinal);

        /// <summary>
        /// The three default planes come before the origin in every part. Which is
        /// which comes from the plane normal, not the name, so renamed or
        /// translated templates still map: normal Z is Front, Y is Top, X is Right.
        /// </summary>
        private void FindDefaultPlanes()
        {
            var fallback = new[] { "FRONT", "TOP", "RIGHT" };
            int k = 0;
            foreach (var node in ctx.Top)
            {
                if (node.Type == "OriginProfileFeature") break;
                if (node.Type != "RefPlane") continue;
                string datum = null;
                var t = Com.Doubles(Com.Try(() => (node.Feature.GetSpecificFeature2() as RefPlane)?.Transform?.ArrayData));
                if (t != null)
                {
                    var n = Vec.At(t, 6);
                    if (Math.Abs(Math.Abs(n[2]) - 1) < 1e-9) datum = "FRONT";
                    else if (Math.Abs(Math.Abs(n[1]) - 1) < 1e-9) datum = "TOP";
                    else if (Math.Abs(Math.Abs(n[0]) - 1) < 1e-9) datum = "RIGHT";
                }
                datum = datum ?? (k < fallback.Length ? fallback[k] : null);
                if (datum != null && !ctx.DefaultPlanes.ContainsValue(datum)) ctx.DefaultPlanes[node.Name] = datum;
                if (++k == 3) break;
            }
        }

        // --- pass 1 -------------------------------------------------------------------

        private void Extract(TreeNode node, FeatureReaders readers, JArr ignored)
        {
            ctx.Topology.Discard();
            try
            {
                if (node.Type == "ProfileFeature")
                {
                    readers.Sketch(node);
                    return;
                }
                if (node.Type == "3DProfileFeature") throw new UnsupportedException("3D sketch (Onshape sketches are planar)");
                if (node.Type == "RefPlane" && ctx.DefaultPlanes.ContainsKey(node.Name))
                {
                    ctx.Report.Entry(node, "datum").Add("ir", ctx.DefaultPlanes[node.Name]);
                    return;
                }
                if (IsIgnored(node.Type))
                {
                    ignored.Add(node.Name);
                    return;
                }

                var definition = Com.Try(() => node.Feature.GetDefinition());
                switch (definition)
                {
                    case IExtrudeFeatureData2 d: readers.Extrude(node, d); return;
                    case IRevolveFeatureData2 d: readers.Revolve(node, d); return;
                    case ISimpleFilletFeatureData2 d: readers.Fillet(node, d); return;
                    case IChamferFeatureData2 d: readers.Chamfer(node, d); return;
                    case IWizardHoleFeatureData2 d: readers.Hole(node, d); return;
                    case IShellFeatureData d: readers.Shell(node, d); return;
                    case ILinearPatternFeatureData d: readers.LinearPattern(node, d); return;
                    case ICircularPatternFeatureData d: readers.CircularPattern(node, d); return;
                    case IMirrorPatternFeatureData d: readers.Mirror(node, d); return;
                    case IRefPlaneFeatureData d: readers.Plane(node, d); return;
                }
                throw new UnsupportedException($"{node.Type} features have no IR form yet");
            }
            catch (UnsupportedException e)
            {
                ctx.Topology.Discard();
                ctx.Report.Entry(node, "unsupported", e.Message);
                ctx.Log($"  --   {node.Name} ({node.Type}): not carried: {e.Message}");
                ReportOrphanedSketches(node);
            }
            catch (Exception e) when (e is COMException || e is InvalidCastException || e is NullReferenceException || e is IndexOutOfRangeException || e is ArgumentException)
            {
                ctx.Topology.Discard();
                ctx.Report.Entry(node, "error", $"{e.GetType().Name}: {e.Message}");
                ctx.Log($"  !!   {node.Name} ({node.Type}): extraction failed: {e.Message}");
                ReportOrphanedSketches(node);
            }
        }

        /// <summary>Sketches a feature absorbed are left out with it; say so, so nothing disappears unreported.</summary>
        private void ReportOrphanedSketches(TreeNode owner)
        {
            foreach (var sub in owner.Subs)
            {
                if (sub.Owner != owner || ctx.Sketches.ContainsKey(sub.Name) || (sub.Type != "ProfileFeature" && sub.Type != "3DProfileFeature")) continue;
                ctx.Report.Entry(sub, "skipped", $"belongs to {owner.Name}, which is not carried");
            }
        }

        // --- pass 2 -------------------------------------------------------------------

        /// <summary>
        /// Visit each needed rollback state once, in tree order: after every
        /// solid feature for its evidence, and wherever references wait to be
        /// re-measured. Returns the number of states visited.
        /// </summary>
        private int RollbackPass()
        {
            var evidenceAt = new Dictionary<int, IrFeature>();
            foreach (var f in ctx.Features)
                if (f.Solid && !f.Source.Suppressed) evidenceAt[f.Source.Anchor.Index] = f;
            var states = new SortedSet<int>(ctx.Topology.States.Concat(evidenceAt.Keys));
            if (states.Count == 0) return 0;

            ctx.Log($"rolling back through {states.Count} states for evidence");
            int visited = 0;
            try
            {
                foreach (int k in states)
                {
                    var at = ctx.Top[k];
                    if (!RollTo(swMoveRollbackBarTo_e.swMoveRollbackBarToAfterFeature, at.Name)) continue;
                    visited++;
                    try
                    {
                        if (evidenceAt.TryGetValue(k, out var feature)) feature.Node.Add("evidence", Evidence.Measure(ctx));
                        ctx.Topology.Resolve(k);
                    }
                    catch (Exception e) when (!(e is OutOfMemoryException))
                    {
                        ctx.Report.Warn($"after {at.Name}", $"measuring failed ({e.GetType().Name}: {e.Message}); this state has no evidence");
                    }
                }
            }
            finally
            {
                RollTo(swMoveRollbackBarTo_e.swMoveRollbackBarToEnd, "");
            }
            return visited;
        }

        private bool RollTo(swMoveRollbackBarTo_e where, string feature)
        {
            bool ok = Com.Try(() => ctx.Doc.FeatureManager.EditRollback((int)where, feature));
            if (!ok) ctx.Report.Warn("rollback", $"could not move the rollback bar ({where}{(feature.Length > 0 ? " " + feature : "")})");
            return ok;
        }

        // --- document data ----------------------------------------------------------------

        private JObj CustomProperties(string configuration)
        {
            var props = new JObj();
            void Read(string config)
            {
                var manager = Com.Try(() => ctx.Ext.CustomPropertyManager[config]);
                if (manager == null) return;
                object names = null, types = null, values = null, resolved = null, links = null;
                Com.Try(() => manager.GetAll3(ref names, ref types, ref values, ref resolved, ref links));
                var n = Com.Objects(names);
                var v = Com.Objects(values);
                var r = Com.Objects(resolved);
                for (int i = 0; i < n.Length; i++)
                {
                    var value = (i < r.Length ? r[i] as string : null) ?? (i < v.Length ? v[i] as string : null);
                    if (n[i] is string name && value != null) props.Add(name, value);
                }
            }
            Read("");
            if (!string.IsNullOrEmpty(configuration)) Read(configuration);
            if (!props.Has("Material"))
            {
                string database = null;
                var material = Com.Try(() => ctx.Part.GetMaterialPropertyName2(configuration ?? "", out database));
                if (!string.IsNullOrEmpty(material)) props.Add("Material", material);
            }
            return props.Count > 0 ? props : null;
        }

        /// <summary>sha256 of the source file; SOLIDWORKS holds it open, so share everything.</summary>
        private static string Hash(string path)
        {
            if (string.IsNullOrEmpty(path) || !File.Exists(path)) return null;
            using (var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
            using (var sha = SHA256.Create())
                return string.Concat(sha.ComputeHash(stream).Select(b => b.ToString("x2")));
        }
    }
}
