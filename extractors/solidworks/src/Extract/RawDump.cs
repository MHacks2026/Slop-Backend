using System;
using System.Reflection;
using System.Runtime.InteropServices;
using Slop.SolidWorks.Core;

namespace Slop.SolidWorks.Extract
{
    /// <summary>
    /// Every readable scalar property of a feature-data object, for
    /// <c>ext.sw.data</c>: "nothing extracted is ever thrown away, even if no
    /// target can use it yet" (architecture doc §5). Options the IR does not
    /// model (thin walls, overflow handling, hole thread classes) stay visible
    /// to the translator this way. COM objects are summarised, not followed.
    /// </summary>
    internal static class RawDump
    {
        public static JObj Of(object com, Type iface)
        {
            var o = new JObj();
            if (com == null || iface == null) return o;
            foreach (var p in iface.GetProperties(BindingFlags.Public | BindingFlags.Instance))
            {
                if (!p.CanRead || p.GetIndexParameters().Length > 0) continue;
                object value;
                try
                {
                    value = p.GetValue(com, null);
                }
                catch (Exception)
                {
                    continue; // not available for this feature, or needs AccessSelections
                }
                var simple = Simplify(value);
                if (simple != null) o.Add(p.Name, simple);
            }
            return o;
        }

        private static object Simplify(object v)
        {
            switch (v)
            {
                case null:
                    return null;
                case bool _:
                case int _:
                case string _:
                    return v;
                case double d:
                    return double.IsNaN(d) || double.IsInfinity(d) ? null : (object)d;
                case float f:
                    return float.IsNaN(f) || float.IsInfinity(f) ? null : (object)(double)f;
                case short s:
                    return (int)s;
                case long l:
                    return l;
                case Array a:
                    if (a.Length == 0) return null;
                    var first = a.GetValue(0);
                    if (first == null || Marshal.IsComObject(first)) return $"{a.Length} object(s)";
                    var arr = new JArr();
                    foreach (var x in a)
                    {
                        var s = Simplify(x);
                        if (s != null) arr.Add(s);
                    }
                    return arr;
                default:
                    return Marshal.IsComObject(v) ? "object" : v.ToString();
            }
        }
    }
}
