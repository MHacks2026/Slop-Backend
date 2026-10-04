using System;
using Slop.SolidWorks.Core;
using Xunit;

namespace Slop.SolidWorks.Tests
{
    public class JsonTests
    {
        [Fact]
        public void KeepsInsertionOrderAndDropsNulls()
        {
            var o = new JObj().Add("id", "f1").Add("missing", null).Add("op", "sketch");
            Assert.Equal("{\n  \"id\": \"f1\",\n  \"op\": \"sketch\"\n}\n", Json.Write(o));
        }

        [Fact]
        public void ReplacingAKeyKeepsItsPosition()
        {
            var o = new JObj().Add("a", 1).Add("b", 2).Add("a", 3);
            Assert.Equal("{\n  \"a\": 3,\n  \"b\": 2\n}\n", Json.Write(o));
        }

        [Fact]
        public void ShortScalarArraysStayOnOneLine()
        {
            var o = new JObj().Add("p", JArr.Of(0.05, 0.0)).Add("args", JArr.Of("l1.start", "ORIGIN"));
            Assert.Equal("{\n  \"p\": [0.05, 0],\n  \"args\": [\"l1.start\", \"ORIGIN\"]\n}\n", Json.Write(o));
        }

        [Fact]
        public void ArraysOfObjectsGoMultiLine()
        {
            var a = JArr.Of(new JObj().Add("x", 1));
            Assert.Equal("[\n  {\n    \"x\": 1\n  }\n]\n", Json.Write(a));
        }

        [Fact]
        public void EscapesStrings()
        {
            Assert.Equal("\"a\\\"b\\\\c\\n\\u0001\"\n", Json.Write("a\"b\\c\n\u0001"));
        }

        [Fact]
        public void RejectsNonFiniteNumbers()
        {
            Assert.Throws<ArgumentException>(() => Json.Write(double.NaN));
        }
    }

    public class NumTests
    {
        [Theory]
        [InlineData(0.049999999999999996, "0.05")]
        [InlineData(0.010000000000000002, "0.01")]
        [InlineData(-1.2e-17, "0")]
        [InlineData(-0.0, "0")]
        [InlineData(1.0, "1")]
        [InlineData(6.283185307179586, "6.28318530718")]
        [InlineData(1.4787757144e-05, "1.4787757144E-05")]
        public void CleansKernelNoise(double input, string expected)
        {
            Assert.Equal(expected, Num.Format(input));
        }

        [Fact]
        public void NearIsRelativeAboveOne()
        {
            Assert.True(Num.Near(1000.0, 1000.0000001));
            Assert.False(Num.Near(0.001, 0.0011));
        }
    }

    public class UnitsTests
    {
        [Fact]
        public void WritesLiteralsInDocumentUnits()
        {
            Assert.Equal("50 mm", Units.Millimeters.Length(0.05));
            Assert.Equal("2.5 mm", Units.Millimeters.Length(0.0025));
            Assert.Equal("360 deg", Units.Millimeters.Angle(2 * Math.PI));
            var inches = Units.FromSolidWorks(3, 0);
            Assert.Equal("1.25 in", inches.Length(0.03175));
        }

        [Fact]
        public void UnsupportedUnitsFallBackToMillimetres()
        {
            var microns = Units.FromSolidWorks(8, 3);
            Assert.Equal("mm", microns.LengthSymbol);
            Assert.Equal("rad", microns.AngleSymbol);
        }

        [Theory]
        [InlineData(50.000000000001, "50")]
        [InlineData(-12.7, "-12.7")]
        [InlineData(1e-11, "0")]
        [InlineData(0.125, "0.125")]
        public void FormatsPlainNumbers(double x, string expected)
        {
            Assert.Equal(expected, Units.FormatNumber(x));
        }
    }

    public class EquationTests
    {
        [Fact]
        public void SplitsAtTheFirstUnquotedEqualsAndDropsComments()
        {
            var e = EquationParser.Parse("\"D1@Sketch1\" = \"Width\" * 2 'keeps it centred");
            Assert.Equal("D1@Sketch1", e.Lhs);
            Assert.Equal("\"Width\" * 2", e.Rhs);
            Assert.Equal("keeps it centred", e.Comment);
            Assert.Equal(new[] { "Width" }, e.References);
        }

        [Fact]
        public void QuotedEqualsSignsAreNotSplitPoints()
        {
            var e = EquationParser.Parse("\"A=B\"= 5");
            Assert.Equal("A=B", e.Lhs);
            Assert.Equal("5", e.Rhs);
        }

        [Fact]
        public void ReturnsNullWithoutAnEqualsSign() => Assert.Null(EquationParser.Parse("\"Width\""));

        [Fact]
        public void RecognisesASingleReference()
        {
            Assert.Equal("Width", EquationParser.SingleReference(" \"Width\" "));
            Assert.Null(EquationParser.SingleReference("\"Width\" / 2"));
        }

        [Theory]
        [InlineData("50", 50, "")]
        [InlineData("50mm", 50, "mm")]
        [InlineData(" 2.5 in ", 2.5, "in")]
        [InlineData("90deg", 90, "deg")]
        [InlineData("-1.5E-2 m", -0.015, "m")]
        public void ParsesLiterals(string rhs, double number, string unit)
        {
            Assert.True(EquationParser.TryParseLiteral(rhs, out var n, out var u));
            Assert.Equal(number, n, 12);
            Assert.Equal(unit, u);
        }

        [Fact]
        public void ExpressionsAreNotLiterals() => Assert.False(EquationParser.TryParseLiteral("\"Width\" / 2", out _, out _));
    }

    public class TransformTests
    {
        private static double[] Sw(double[] x, double[] y, double[] z, double[] t) =>
            new[] { x[0], x[1], x[2], y[0], y[1], y[2], z[0], z[1], z[2], t[0], t[1], t[2], 1, 0, 0, 0 };

        [Fact]
        public void IdentityStaysIdentity()
        {
            var m = Transforms.ToIrMat4(Sw(new[] { 1.0, 0, 0 }, new[] { 0.0, 1, 0 }, new[] { 0.0, 0, 1 }, new[] { 0.0, 0, 0 }));
            Assert.Equal(new double[] { 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1 }, m);
        }

        [Fact]
        public void RowsOfTheSolidWorksRotationBecomeColumns()
        {
            // A sketch on a face 10 mm up, as in plate.ir.json f3.
            var lifted = Transforms.ToIrMat4(Sw(new[] { 1.0, 0, 0 }, new[] { 0.0, 1, 0 }, new[] { 0.0, 0, 1 }, new[] { 0.0, 0, 0.01 }));
            Assert.Equal(new double[] { 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0.01, 0, 0, 0, 1 }, lifted);

            // Top plane: sketch x is model X, sketch y is model -Z, normal +Y.
            var top = Transforms.ToIrMat4(Sw(new[] { 1.0, 0, 0 }, new[] { 0.0, 0, -1 }, new[] { 0.0, 1, 0 }, new[] { 0.0, 0, 0 }));
            Assert.Equal(new[] { 0.02, 0, -0.03 }, Transforms.ApplyPoint(top, 0.02, 0.03, 0));
            Assert.Equal(new[] { 0.0, 1, 0 }, Transforms.Normal(top));
        }
    }

    public class ArcTests
    {
        private static readonly double[] C = { 0, 0 };

        [Fact]
        public void QuarterArcDirectionFollowsLength()
        {
            double r = 0.01;
            double quarter = r * Math.PI / 2;
            Assert.True(Arcs.CcwFromLength(C, new[] { r, 0 }, new[] { 0, r }, quarter));
            Assert.False(Arcs.CcwFromLength(C, new[] { r, 0 }, new[] { 0, r }, 3 * quarter));
        }

        [Fact]
        public void SemicircleIsAmbiguous()
        {
            double r = 0.01;
            Assert.Null(Arcs.CcwFromLength(C, new[] { r, 0 }, new[] { -r, 0 }, Math.PI * r));
        }

        [Fact]
        public void SweepIsInZeroToTwoPi()
        {
            Assert.Equal(Math.PI / 2, Arcs.CcwSweep(C, new[] { 1.0, 0 }, new[] { 0.0, 1 }), 12);
            Assert.Equal(3 * Math.PI / 2, Arcs.CcwSweep(C, new[] { 0.0, 1 }, new[] { 1.0, 0 }), 12);
        }
    }

    public class IdTests
    {
        [Fact]
        public void SanitizesToTheSchemaAlphabet()
        {
            Assert.Equal("D1@Base_Plate", Ids.Sanitize("D1@Base Plate"));
            Assert.Equal("Line_1", Ids.SanitizeEntity("Line#1"));
        }

        [Fact]
        public void AllocatesSequentiallyAndKeepsUniqueIdsUnique()
        {
            var ids = new IdAllocator();
            Assert.Equal("f1", ids.Next("f"));
            Assert.Equal("f2", ids.Next("f"));
            Assert.Equal("l1", ids.Next("l"));
            Assert.Equal("D1@Sketch1", ids.Unique("D1@Sketch1"));
            Assert.Equal("D1@Sketch1_2", ids.Unique("D1@Sketch1"));
            Assert.Equal("f3", ids.Next("f"));
        }
    }
}
