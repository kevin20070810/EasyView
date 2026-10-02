# -*- coding: utf-8 -*-
"""用真实 CPython 当基准，反推 list.sort 在"非全序"key 下的落点规则。"""
import itertools
import random
import sys

sys.stdout.reconfigure(encoding="utf-8", errors="backslashreplace")

NAN = float("nan")


def lt(a, b):
    # Python 的元组/list 比较
    return a < b


def model_count_run(keys):
    n = len(keys)
    if n < 2:
        return n, False
    descending = lt(keys[1], keys[0])
    i = 1
    if descending:
        while i + 1 < n and lt(keys[i + 1], keys[i]):
            i += 1
    else:
        while i + 1 < n and not lt(keys[i + 1], keys[i]):
            i += 1
    return i + 1, descending


def model_binarysort(keys, start, pivot_first_direction):
    keys = list(keys)
    n = len(keys)
    for s in range(start, n):
        pivot = keys[s]
        l, r = 0, s
        while l < r:
            p = l + ((r - l) >> 1)
            if pivot_first_direction:
                if lt(pivot, keys[p]):
                    r = p
                else:
                    l = p + 1
            else:
                if lt(keys[p], pivot):
                    l = p + 1
                else:
                    r = p
        item = keys.pop(s)
        keys.insert(l, item)
    return keys


def model_sort(keys, direction=True):
    if len(keys) < 64:
        run, desc = model_count_run(keys)
        keys = list(keys)
        if desc:
            keys[:run] = keys[:run][::-1]
        return model_binarysort(keys, run, direction)
    return sorted(keys)


def main():
    rng = random.Random(7)
    pool = [NAN, 0, 1, 2, 3]
    bad_true = bad_false = 0
    shown = 0
    for trial in range(4000):
        n = rng.randint(2, 6)
        keys = [rng.choice(pool) for _ in range(n)]
        real = sorted(keys)
        m1 = model_sort(keys, True)
        m2 = model_sort(keys, False)
        same1 = real == m1 or all(
            (a == b or (isinstance(a, float) and isinstance(b, float) and a != a and b != b))
            for a, b in zip(real, m1))
        same2 = real == m2 or all(
            (a == b or (isinstance(a, float) and isinstance(b, float) and a != a and b != b))
            for a, b in zip(real, m2))
        if not same1 and not same2 and shown < 12:
            print("都不匹配: %s -> real=%s modelA=%s modelB=%s" % (keys, real, m1, m2))
            shown += 1
        if same1:
            bad_true += 1
        if same2:
            bad_false += 1
    print("总试 %d；模型 A(pivot<key[p] 时 r=p) 匹配 %d；模型 B(key[p]<pivot 时 l=p+1) 匹配 %d"
          % (4000, bad_true, bad_false))
    # 指定用例
    for keys in [[NAN, 10.0, 0.0], [NAN, 0.0, 10.0], [0.0, NAN, 10.0], [10.0, 10.0, NAN, 0.0],
                 [NAN, 30.0, 20.0, 10.0]]:
        print("%s -> real=%s modelA=%s modelB=%s"
              % (keys, sorted(keys), model_sort(keys, True), model_sort(keys, False)))


if __name__ == "__main__":
    main()
