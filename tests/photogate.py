# Warehouse photos come first (v2.11): fill the blocking photo step if it shows.
# Uses the test photos ui_test.py writes to /tmp/ndd-ui (p0.jpg .. p2.jpg).
import os
def gate(pg, n=3, out="/tmp/ndd-ui"):
    try: pg.wait_for_selector("#modal.lock.on", timeout=4000)
    except Exception: return False
    for i in range(n):
        os.utime(f"{out}/p{i}.jpg", None); pg.set_input_files("#sheet input[type=file]", f"{out}/p{i}.jpg"); pg.wait_for_selector(f"#sheet >> text={i + 1} of 5 photos", timeout=15000)
    pg.click("#sheet button.big1"); pg.wait_for_timeout(300)
    return True
