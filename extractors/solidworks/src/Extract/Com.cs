using System;
using System.Collections.Generic;
using SolidWorks.Interop.sldworks;
using SolidWorks.Interop.swconst;

namespace Slop.SolidWorks.Extract
{
    /// <summary>
    /// Unwrapping the VARIANTs the SOLIDWORKS API returns: arrays arrive as
    /// object, may be null for "none", and integer arrays may be int[] or
    /// long[] depending on the call.
    /// </summary>
    internal static class Com
    {
        public static object[] Objects(object v)
        {
            if (v == null) return Array.Empty<object>();
            if (v is object[] a) return a;
            if (v is Array arr)
            {
                var o = new object[arr.Length];
                arr.CopyTo(o, 0);
                return o;
            }
            return new[] { v };
        }

        public static double[] Doubles(object v)
        {
            if (v == null) return null;
            if (v is double[] d) return d;
            if (v is Array arr)
            {
                var o = new double[arr.Length];
                for (int i = 0; i < arr.Length; i++) o[i] = Convert.ToDouble(arr.GetValue(i));
                return o;
            }
            return null;
        }

        public static int[] Ints(object v)
        {
            if (v == null) return Array.Empty<int>();
            if (v is int[] i) return i;
            if (v is Array arr)
            {
                var o = new int[arr.Length];
                for (int k = 0; k < arr.Length; k++) o[k] = Convert.ToInt32(arr.GetValue(k));
                return o;
            }
            return new[] { Convert.ToInt32(v) };
        }

        /// <summary>Sub-features in order (sketches under an extrude, sketches under a Hole Wizard ...).</summary>
        public static IEnumerable<Feature> SubFeatures(Feature f)
        {
            for (var s = f.GetFirstSubFeature() as Feature; s != null; s = s.GetNextSubFeature() as Feature)
                yield return s;
        }

        public static IEnumerable<DisplayDimension> DisplayDimensions(Feature f)
        {
            for (var d = f.GetFirstDisplayDimension() as DisplayDimension; d != null; d = f.GetNextDisplayDimension(d) as DisplayDimension)
                yield return d;
        }

        public static bool IsSuppressed(Feature f)
        {
            try
            {
                var states = f.IsSuppressed2((int)swInConfigurationOpts_e.swThisConfiguration, null) as bool[];
                return states != null && states.Length > 0 ? states[0] : f.IsSuppressed();
            }
            catch (Exception)
            {
                return f.IsSuppressed();
            }
        }

        /// <summary>System value of a dimension in the active configuration (metres or radians).</summary>
        public static double SystemValue(Dimension d)
        {
            try
            {
                var values = Doubles(d.GetSystemValue3((int)swInConfigurationOpts_e.swThisConfiguration, null));
                if (values != null && values.Length > 0) return values[0];
            }
            catch (Exception)
            {
                // fall through to the active-configuration property
            }
            return d.SystemValue;
        }

        /// <summary>Key for a sketch point: unique among points of one sketch (ISketchPoint::GetID).</summary>
        public static string PointKey(SketchPoint p)
        {
            var id = Ints(p.GetID());
            return id.Length >= 2 ? $"{id[0]}:{id[1]}" : string.Join(":", id);
        }

        /// <summary>
        /// Key for a sketch segment. Segment ids are unique per segment type only
        /// (a line and an arc may share one), so the type is part of the key.
        /// </summary>
        public static string SegmentKey(SketchSegment s)
        {
            var id = Ints(s.GetID());
            return $"{s.GetType()}:{(id.Length >= 2 ? $"{id[0]}:{id[1]}" : string.Join(":", id))}";
        }

        /// <summary>Name of the feature behind a sketch, plane or feature object, or null.</summary>
        public static string FeatureName(object o)
        {
            try
            {
                return (o as Feature)?.Name;
            }
            catch (Exception)
            {
                return null;
            }
        }

        public static T Try<T>(Func<T> get, T fallback = default)
        {
            try
            {
                return get();
            }
            catch (Exception)
            {
                return fallback;
            }
        }
    }
}
