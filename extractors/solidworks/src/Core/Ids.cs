using System.Collections.Generic;
using System.Text.RegularExpressions;

namespace Slop.SolidWorks.Core
{
    /// <summary>
    /// IR identifiers. The schema allows <c>[A-Za-z0-9_@.:-]</c> in ids and
    /// <c>[A-Za-z0-9_-]</c> in sketch entity ids (ir.schema.json, Id and
    /// SketchArg); SOLIDWORKS names may hold spaces and anything else.
    /// </summary>
    public static class Ids
    {
        private static readonly Regex NotId = new Regex("[^A-Za-z0-9_@.:-]", RegexOptions.Compiled);
        private static readonly Regex NotEntity = new Regex("[^A-Za-z0-9_-]", RegexOptions.Compiled);

        /// <summary>"D1@Base Plate" -> "D1@Base_Plate".</summary>
        public static string Sanitize(string s)
        {
            var t = NotId.Replace(s ?? "", "_");
            return t.Length == 0 ? "_" : t;
        }

        public static string SanitizeEntity(string s)
        {
            var t = NotEntity.Replace(s ?? "", "_");
            return t.Length == 0 ? "_" : t;
        }
    }

    /// <summary>Short sequential ids per prefix: f1, f2 ... l1, l2 ... c1.</summary>
    public sealed class IdAllocator
    {
        private readonly Dictionary<string, int> counters = new Dictionary<string, int>();
        private readonly HashSet<string> taken = new HashSet<string>();

        public string Next(string prefix)
        {
            counters.TryGetValue(prefix, out int n);
            string id;
            do id = prefix + (++n); while (taken.Contains(id));
            counters[prefix] = n;
            taken.Add(id);
            return id;
        }

        /// <summary>Reserve <paramref name="id"/>, suffixing _2, _3 ... when it is already taken.</summary>
        public string Unique(string id)
        {
            string candidate = id;
            for (int k = 2; taken.Contains(candidate); k++) candidate = $"{id}_{k}";
            taken.Add(candidate);
            return candidate;
        }
    }
}
