#!/usr/bin/env python3
"""
skyfield-reference.py — independent SGP4 reference states for OrbitWatch.

Why this exists
---------------
OrbitWatch propagates element sets with `satellite.js`. To verify that pipeline
independently, this script re-propagates the *same element sets* with a
separately implemented SGP4 — Brandon Rhodes' `sgp4` package, a direct
transcription of Vallado's reference implementation (AIAA 2006-6753) — and a
different geodetic solution (`skyfield`, WGS-84). The results are committed as a
fixture, and the vitest suite compares the application's own numbers against it.

Agreement demonstrates the JS pipeline is correct. Disagreement is a genuine
defect to fix, never a tolerance to widen.

Usage:
    python3 -m pip install skyfield sgp4
    python3 tools/skyfield-reference.py

Notes on faithfulness
---------------------
The upstream payload is OMM JSON while the Python SGP4 takes TLE text, so the
elements are written back out in the standard fixed-column TLE layout. The
script then *verifies its own reconstruction* against the JSON before emitting
any reference state: if a reconstructed element differs from the published value
by more than a stated tolerance, it aborts rather than producing a misleading
fixture.
"""
from __future__ import annotations

import datetime as dt
import json
import math
import pathlib
import sys

try:
    from skyfield.api import EarthSatellite, load
    from sgp4.api import Satrec, jday
except ImportError:  # pragma: no cover
    sys.exit("Missing dependencies. Install with:\n    python3 -m pip install skyfield sgp4\n")

ROOT = pathlib.Path(__file__).resolve().parent.parent
FIXTURES = ROOT / "tests" / "fixtures"
SAMPLES = FIXTURES / "gp-samples.json"
OUT = FIXTURES / "reference-states.json"

# Propagation instants (UTC): minutes to days after the element epochs, so the
# comparison exercises short-term and multi-day propagation.
INSTANTS = [
    "2026-10-10T00:00:00Z",
    "2026-10-10T12:34:56Z",
    "2026-10-11T18:00:00Z",
    "2026-10-13T06:30:00Z",
]

# Bounds used to sanity-check the TLE reconstruction against the source JSON.
ELEMENT_TOLERANCES = {
    "inclinationDeg": 1e-4,
    "raanDeg": 1e-4,
    "eccentricity": 1e-7,
    "argPerigeeDeg": 1e-4,
    "meanAnomalyDeg": 1e-4,
    "meanMotionRevPerDay": 1e-8,
    "bstar": 1e-7,
}

ts = load.timescale()


def fmt_exp(value: float) -> str:
    """TLE assumed-decimal-point exponent field: ' 13074-3' == 0.13074e-3."""
    if value == 0:
        return " 00000+0"
    sign = "-" if value < 0 else " "
    value = abs(value)
    exp = math.floor(math.log10(value)) + 1
    mant = value / (10 ** exp)
    digits = int(round(mant * 100000))
    if digits >= 100000:
        digits //= 10
        exp += 1
    return f"{sign}{digits:05d}{'-' if exp < 0 else '+'}{abs(exp)}"


def checksum(line: str) -> str:
    total = 0
    for ch in line[:68]:
        if ch.isdigit():
            total += int(ch)
        elif ch == "-":
            total += 1
    return str(total % 10)


def fmt_ndot(value: float) -> str:
    """TLE ndot field (10 chars): sign + '.' + 8 digits, value assumed in rev/day^2."""
    digits = f"{abs(value):.8f}".split(".")[1]
    return f"{'-' if value < 0 else ' '}.{digits}"


def tle_lines(record: dict) -> tuple[str, str]:
    """Reconstruct standard TLE lines from an OMM record.

    TLE stores the *scaled* time derivatives (ndot/2 and nddot/6), while the OMM
    JSON publishes the unscaled values; the conversions below are the standard
    ones from AIAA 2006-6753.
    """
    epoch = dt.datetime.fromisoformat(str(record["EPOCH"]).replace("Z", "") + "+00:00")
    year = epoch.year
    doy = (epoch - dt.datetime(year, 1, 1, tzinfo=dt.timezone.utc)).total_seconds() / 86400.0 + 1.0
    ecc_digits = f"{float(record['ECCENTRICITY']):.7f}".split(".")[1]
    designator = str(record.get("OBJECT_ID") or "").strip()[:8].ljust(8)
    ndot = (record.get("MEAN_MOTION_DOT") or 0.0) / 2.0
    nddot = (record.get("MEAN_MOTION_DDOT") or 0.0) / 6.0
    line1_body = (
        f"1 {int(record['NORAD_CAT_ID']):05d}U {designator} {year % 100:02d}{doy:012.8f} "
        f"{fmt_ndot(ndot)} "
        f"{fmt_exp(nddot)} "
        f"{fmt_exp(float(record.get('BSTAR') or 0.0))} 0 "
        f"{int(record.get('ELEMENT_SET_NO') or 999):4d}"
    )
    line1 = line1_body.ljust(68)[:68] + checksum(line1_body.ljust(68)[:68])
    line2_body = (
        f"2 {int(record['NORAD_CAT_ID']):05d} "
        f"{float(record['INCLINATION']):8.4f} {float(record['RA_OF_ASC_NODE']):8.4f} "
        f"{ecc_digits} {float(record['ARG_OF_PERICENTER']):8.4f} "
        f"{float(record['MEAN_ANOMALY']):8.4f} {float(record['MEAN_MOTION']):11.8f}"
        f"{int(record.get('REV_AT_EPOCH') or 0):5d}"
    )
    line2 = line2_body.ljust(68)[:68] + checksum(line2_body.ljust(68)[:68])
    return line1, line2


def verify_reconstruction(record: dict, satrec: Satrec) -> None:
    """Confirm the TLE round-trip preserved the published elements."""
    checks = {
        "inclinationDeg": (math.degrees(satrec.inclo), float(record["INCLINATION"])),
        "raanDeg": (math.degrees(satrec.nodeo) % 360.0, float(record["RA_OF_ASC_NODE"])),
        "eccentricity": (satrec.ecco, float(record["ECCENTRICITY"])),
        "argPerigeeDeg": (math.degrees(satrec.argpo) % 360.0, float(record["ARG_OF_PERICENTER"])),
        "meanAnomalyDeg": (math.degrees(satrec.mo) % 360.0, float(record["MEAN_ANOMALY"])),
        "meanMotionRevPerDay": (satrec.no_kozai * 1440.0 / (2 * math.pi), float(record["MEAN_MOTION"])),
        "bstar": (satrec.bstar, float(record.get("BSTAR") or 0.0)),
    }
    for name, (got, want) in checks.items():
        tol = ELEMENT_TOLERANCES[name]
        if abs(got - want) > tol:
            raise SystemExit(
                f"Reconstructed {name} for NORAD {record['NORAD_CAT_ID']} is {got!r} "
                f"but the published value is {want!r} (tolerance {tol}).\n"
                "The TLE reconstruction is not faithful; refusing to emit reference data."
            )


def main() -> None:
    samples = json.loads(SAMPLES.read_text())
    entries = []

    for item in samples["items"]:
        record = item["record"]
        line1, line2 = tle_lines(record)
        satrec = Satrec.twoline2rv(line1, line2)
        verify_reconstruction(record, satrec)
        satellite = EarthSatellite.from_satrec(satrec, ts)

        for instant in INSTANTS:
            year, month, day = int(instant[0:4]), int(instant[5:7]), int(instant[8:10])
            hour, minute, second = int(instant[11:13]), int(instant[14:16]), int(instant[17:19])
            t = ts.utc(year, month, day, hour, minute, second)
            # Julian date built directly from the UTC calendar fields, exactly as
            # satellite.js does — so no UT1/UTC offset contaminates the comparison.
            jd, fr = jday(year, month, day, hour, minute, second)
            err, r, v = satrec.sgp4(jd, fr)
            if err != 0:
                entries.append({
                    "noradId": int(record["NORAD_CAT_ID"]),
                    "instant": instant,
                    "sgp4ErrorCode": int(err),
                    "note": "reference SGP4 reported an error at this instant",
                })
                continue

            subpoint = satellite.at(t).subpoint()
            entries.append({
                "noradId": int(record["NORAD_CAT_ID"]),
                "name": record["OBJECT_NAME"],
                "instant": instant,
                "epoch": record["EPOCH"],
                "temeKm": {"x": r[0], "y": r[1], "z": r[2]},
                "temeKmS": {"x": v[0], "y": v[1], "z": v[2]},
                "geodetic": {
                    "latitudeDeg": subpoint.latitude.degrees,
                    "longitudeDeg": subpoint.longitude.degrees,
                    "altitudeKm": subpoint.elevation.km,
                },
            })

    OUT.write_text(json.dumps({
        "generatedBy": "tools/skyfield-reference.py",
        "purpose": (
            "Independent reference states used by tests/orbital-reference.test.ts to verify this "
            "application's satellite.js propagation and coordinate pipeline."
        ),
        "implementations": {
            "propagation": "python 'sgp4' package, Satrec.sgp4 (canonical Vallado AIAA 2006-6753)",
            "geodetic": "skyfield EarthSatellite.subpoint (WGS-84)",
            "tleReconstruction": "OMM -> fixed-column TLE, verified against the published elements",
        },
        "entries": entries,
    }, indent=2) + "\n")
    print(f"Wrote {len(entries)} reference states to {OUT.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
