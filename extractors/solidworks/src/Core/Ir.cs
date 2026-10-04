namespace Slop.SolidWorks.Core
{
    /// <summary>
    /// Constructors for IR nodes (packages/ir/src/types.ts). Field order follows
    /// the fixtures. Shape is checked on the TypeScript side by
    /// <c>assertValidDocument</c>; these only keep the C# side from drifting.
    /// </summary>
    public static class Ir
    {
        public const string Version = "0.1.0";

        public static class Unit
        {
            public const string Length = "m";
            public const string Angle = "rad";
            public const string None = "";
        }

        public static JObj Quantity(string expr, double value, string unit, string parameter = null) =>
            new JObj().Add("expr", expr).Add("value", value).Add("unit", unit).Add("parameter", parameter);

        /// <summary>FRONT, TOP, RIGHT or ORIGIN, in SOLIDWORKS terms (the builder remaps them for Onshape).</summary>
        public static JObj Datum(string name) => new JObj().Add("kind", "datum").Add("name", name);

        /// <summary>role: region, body, plane, axis or point.</summary>
        public static JObj FeatureOutput(string feature, string role, int? index = null) =>
            new JObj().Add("kind", "feature-output").Add("feature", feature).Add("role", role).Add("index", index);

        public static JObj SketchEntity(string sketch, string entity) =>
            new JObj().Add("kind", "sketch-entity").Add("sketch", sketch).Add("entity", entity);

        /// <summary>Every extracted feature starts at rung "pending"; the builder decides the rung.</summary>
        public static JObj Pending(string notes = null) => new JObj().Add("rung", "pending").Add("notes", notes);

        public static JObj Constraint(string type, params object[] args) => new JObj().Add("type", type).Add("args", new JArr(args));

        /// <summary>Start of every feature node: id, src, op, suppressed, fidelity.</summary>
        public static JObj Feature(string id, string srcName, string srcType, string op, bool suppressed) =>
            new JObj()
                .Add("id", id)
                .Add("src", new JObj().Add("name", srcName).Add("type", srcType))
                .Add("op", op)
                .Add("suppressed", suppressed)
                .Add("fidelity", Pending());
    }
}
