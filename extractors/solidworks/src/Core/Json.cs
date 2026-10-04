using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.Text;

namespace Slop.SolidWorks.Core
{
    /// <summary>
    /// A JSON object that keeps insertion order, so written IR reads in the
    /// same order as the hand-written fixtures (id, src, op, ...). Canonical
    /// hashing on the TypeScript side sorts keys itself, so order here is
    /// only for people.
    /// </summary>
    public sealed class JObj : IEnumerable<KeyValuePair<string, object>>
    {
        private readonly List<KeyValuePair<string, object>> items = new List<KeyValuePair<string, object>>();

        /// <summary>
        /// Set <paramref name="key"/>. A null value removes the key: in the IR an
        /// absent optional field and an unset one mean the same thing.
        /// </summary>
        public JObj Add(string key, object value)
        {
            int i = IndexOf(key);
            if (value == null)
            {
                if (i >= 0) items.RemoveAt(i);
                return this;
            }
            if (i >= 0) items[i] = new KeyValuePair<string, object>(key, value);
            else items.Add(new KeyValuePair<string, object>(key, value));
            return this;
        }

        public object this[string key]
        {
            get
            {
                int i = IndexOf(key);
                return i >= 0 ? items[i].Value : null;
            }
            set => Add(key, value);
        }

        public bool Has(string key) => IndexOf(key) >= 0;

        public int Count => items.Count;

        public JObj GetObj(string key) => this[key] as JObj;

        private int IndexOf(string key)
        {
            for (int i = 0; i < items.Count; i++)
                if (items[i].Key == key) return i;
            return -1;
        }

        public IEnumerator<KeyValuePair<string, object>> GetEnumerator() => items.GetEnumerator();

        IEnumerator IEnumerable.GetEnumerator() => GetEnumerator();
    }

    /// <summary>A JSON array.</summary>
    public sealed class JArr : List<object>
    {
        public JArr() { }

        public JArr(IEnumerable<object> items) : base(items) { }

        public static JArr Of(params object[] items) => new JArr(items);

        public static JArr Vec(double[] v) => new JArr(Array.ConvertAll(v, x => (object)x));
    }

    /// <summary>
    /// Deterministic JSON writer for the IR. Every double goes through
    /// <see cref="Num.Clean"/>, so kernel noise never reaches a file, and
    /// short arrays of scalars (vectors, matrices) stay on one line.
    /// </summary>
    public static class Json
    {
        private const int InlineArrayLimit = 16;

        public static string Write(object value)
        {
            var sb = new StringBuilder();
            WriteValue(sb, value, 0);
            sb.Append('\n');
            return sb.ToString();
        }

        private static void WriteValue(StringBuilder sb, object value, int indent)
        {
            switch (value)
            {
                case null:
                    sb.Append("null");
                    return;
                case string s:
                    WriteString(sb, s);
                    return;
                case bool b:
                    sb.Append(b ? "true" : "false");
                    return;
                case int i:
                    sb.Append(i.ToString(CultureInfo.InvariantCulture));
                    return;
                case long l:
                    sb.Append(l.ToString(CultureInfo.InvariantCulture));
                    return;
                case double d:
                    sb.Append(Num.Format(d));
                    return;
                case float f:
                    sb.Append(Num.Format(f));
                    return;
                case JObj o:
                    WriteObject(sb, o, indent);
                    return;
                case IDictionary<string, string> map:
                    var obj = new JObj();
                    foreach (var kv in map) obj.Add(kv.Key, kv.Value);
                    WriteObject(sb, obj, indent);
                    return;
                case IEnumerable e:
                    WriteArray(sb, e, indent);
                    return;
                default:
                    throw new ArgumentException($"cannot write {value.GetType().Name} as JSON");
            }
        }

        private static void WriteObject(StringBuilder sb, JObj o, int indent)
        {
            if (o.Count == 0)
            {
                sb.Append("{}");
                return;
            }
            sb.Append("{\n");
            int n = 0;
            foreach (var kv in o)
            {
                Indent(sb, indent + 1);
                WriteString(sb, kv.Key);
                sb.Append(": ");
                WriteValue(sb, kv.Value, indent + 1);
                if (++n < o.Count) sb.Append(',');
                sb.Append('\n');
            }
            Indent(sb, indent);
            sb.Append('}');
        }

        private static void WriteArray(StringBuilder sb, IEnumerable e, int indent)
        {
            var list = new List<object>();
            foreach (var x in e) list.Add(x);
            if (list.Count == 0)
            {
                sb.Append("[]");
                return;
            }
            if (list.Count <= InlineArrayLimit && list.TrueForAll(IsScalar))
            {
                sb.Append('[');
                for (int i = 0; i < list.Count; i++)
                {
                    if (i > 0) sb.Append(", ");
                    WriteValue(sb, list[i], indent);
                }
                sb.Append(']');
                return;
            }
            sb.Append("[\n");
            for (int i = 0; i < list.Count; i++)
            {
                Indent(sb, indent + 1);
                WriteValue(sb, list[i], indent + 1);
                if (i < list.Count - 1) sb.Append(',');
                sb.Append('\n');
            }
            Indent(sb, indent);
            sb.Append(']');
        }

        private static bool IsScalar(object x) => x == null || x is string || x is bool || x is int || x is long || x is double || x is float;

        private static void Indent(StringBuilder sb, int indent) => sb.Append(' ', indent * 2);

        private static void WriteString(StringBuilder sb, string s)
        {
            sb.Append('"');
            foreach (char c in s)
            {
                switch (c)
                {
                    case '"': sb.Append("\\\""); break;
                    case '\\': sb.Append("\\\\"); break;
                    case '\n': sb.Append("\\n"); break;
                    case '\r': sb.Append("\\r"); break;
                    case '\t': sb.Append("\\t"); break;
                    case '\b': sb.Append("\\b"); break;
                    case '\f': sb.Append("\\f"); break;
                    default:
                        if (c < 0x20) sb.Append("\\u").Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
                        else sb.Append(c);
                        break;
                }
            }
            sb.Append('"');
        }
    }
}
