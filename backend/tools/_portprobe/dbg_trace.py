# -*- coding: utf-8 -*-
"""用可记录的 key 类，抓出 CPython list.sort 真实的比较序列。"""
import sys

sys.stdout.reconfigure(encoding="utf-8", errors="backslashreplace")

NAN = float("nan")


class TK:
    """模拟 Python 元组 (y, o) 的比较语义，并记录每次比较。"""

    def __init__(self, y, o, tag):
        self.y = y
        self.o = o
        self.tag = tag

    def __repr__(self):
        return "%s(%r,%r)" % (self.tag, self.y, self.o)

    def _lt_tuple(self, other):
        # Python 元组比较 (a0,a1) < (b0,b1)：找第一个不相等的位置（== 判定，
        # 含身份短路），返回该位置上的 <
        y_eq = (self.y is other.y) or (self.y == other.y)
        if not y_eq:
            return self.y < other.y
        o_eq = (self.o is other.o) or (self.o == other.o)
        if not o_eq:
            return self.o < other.o
        return False

    def __lt__(self, other):
        LOG.append(("<", repr(self), repr(other)))
        return self._lt_tuple(other)

    def __gt__(self, other):
        LOG.append((">", repr(self), repr(other)))
        return other._lt_tuple(self)

    __hash__ = None


LOG = []


def run(vals):
    global LOG
    LOG = []
    items = [TK(v, i, chr(ord("A") + i)) for i, v in enumerate(vals)]
    out = sorted(items)
    print("输入 %s -> 输出 %s" % (vals, [x.tag for x in out]))
    for entry in LOG:
        print("   ", entry)
    print()


def main():
    run([2.0, 0.0, NAN])
    run([NAN, 10.0, 0.0])
    run([0.0, 1.0, 2.0])


if __name__ == "__main__":
    main()
