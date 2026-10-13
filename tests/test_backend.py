"""Runs the plugin's backend against a throw-away home folder: python3 tests/test_backend.py  (needs only Python 3.8+)."""
import asyncio, os, sys, tempfile, time, types, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
tmp = tempfile.mkdtemp(prefix="sg-test-")
fake = types.ModuleType("decky")
fake.DECKY_PLUGIN_SETTINGS_DIR = os.path.join(tmp, "settings")
fake.DECKY_PLUGIN_RUNTIME_DIR = os.path.join(tmp, "runtime")
fake.DECKY_USER_HOME = os.path.join(tmp, "home")
import logging
fake.logger = logging.getLogger("t")
sys.modules["decky"] = fake
sys.path.insert(0, os.path.dirname(HERE))
import main  # noqa: E402

bad = 0
def check(c, m):
    global bad
    if not c:
        bad += 1
        print("FAIL:", m)

def shot(app, name, size, when):
    d = os.path.join(tmp, "home", ".local/share/Steam/userdata/123/760/remote", str(app), "screenshots")
    os.makedirs(d, exist_ok=True)
    p = os.path.join(d, name)
    with open(p, "wb") as f:
        f.write(b"\xff\xd8" + b"x" * size + b"\xff\xd9")
    os.utime(p, (when, when))

now = time.time()
stamp = lambda t: time.strftime("%Y%m%d%H%M%S", time.localtime(t)) + "_1.jpg"
shot(620, stamp(now - 40 * 86400), 1000, now - 40 * 86400)
shot(620, stamp(now - 2 * 86400), 3_000_000, now - 2 * 86400)
shot(440, stamp(now - 3600), 500_000, now - 3600)

async def main_test():
    pl = main.Plugin()
    await pl._main()
    ov = await pl.get_overview(True)
    check(ov["total"] == 3, "three screenshots found")
    ids = [x["id"] for x in (await pl.get_shots(0, 0, False))["items"]]
    check(len(ids) == 3, "page has three")
    # sort and filters
    r = await pl.get_shots(0, 0, False, {"sort": "big"})
    check([x["size"] for x in r["items"]] == sorted([x["size"] for x in r["items"]], reverse=True), "sorted by size, biggest first")
    r = await pl.get_shots(0, 0, False, {"sort": "old"})
    check(r["items"][0]["taken"] <= r["items"][-1]["taken"], "oldest first")
    check((await pl.get_shots(0, 0, False, {"days": 7}))["total"] == 2, "last 7 days")
    check((await pl.get_shots(0, 0, False, {"min_mb": 1}))["total"] == 1, "at least 1 MB")
    check((await pl.get_shots(0, 0, False, {"max_mb": 1}))["total"] == 2, "at most 1 MB")
    check((await pl.get_shots(0, 0, False, {"appids": [440]}))["total"] == 1, "only game 440")
    check((await pl.get_ids(0, False, {"days": 7}))["ids"].__len__() == 2, "get_ids uses the same filter")
    # albums
    check((await pl.create_album("  Best   ones "))["name"] == "Best ones", "album name is tidied")
    check(not (await pl.create_album("   "))["ok"], "empty album name refused")
    check((await pl.album_add("Best ones", ids[:2] + ["nope"]))["added"] == 2, "adds known ids only")
    check((await pl.album_add("Best ones", ids[:1]))["added"] == 0, "no duplicates")
    check((await pl.get_shots(0, 0, False, {"album": "Best ones"}))["total"] == 2, "album view")
    check((await pl.album_remove("Best ones", ids[:1]))["removed"] == 1, "remove from album")
    ov = await pl.get_overview(False)
    check(ov["albums"] == [{"name": "Best ones", "count": 1}], "overview lists albums")
    # edited pictures show up
    import base64
    jpg = base64.b64encode(b"\xff\xd8" + b"y" * 200 + b"\xff\xd9").decode()
    r = await pl.save_edit(jpg, 620, {"620": "Portal 2"})
    check(r["ok"], "edit saved")
    ov = await pl.get_overview(False)
    check(ov["total"] == 4 and ov["edited"] == 1, "edited picture is in the gallery")
    items = (await pl.get_shots(620, 0, False))["items"]
    check(any(x["edited"] for x in items), "edited picture belongs to its game")
    ed = [x for x in items if x["edited"]][0]
    check((await pl.prepare_share(ed["id"], {}))["ok"], "an edited picture can be shared as it is")
    n = (await pl.export_organized({}))["copied"]
    check(n == 3, "the organized export copies only real screenshots (got %s)" % n)
    # send to phone
    pl._lan_ip = staticmethod(lambda: "127.0.0.1")
    check(not (await pl.phone_start([]))["ok"], "nothing chosen: refused")
    r = await pl.phone_start(ids)
    check(r["ok"] and r["url"].startswith("http://127.0.0.1:"), "phone link made")
    loop = asyncio.get_running_loop()
    get = lambda u: loop.run_in_executor(None, lambda: urllib.request.urlopen(u, timeout=5).read())
    page = await get(r["url"])
    check(b"3 screenshots" in page and b"th/0" in page, "page lists the screenshots")
    check((await get(r["url"] + "img/0"))[:2] == b"\xff\xd8", "full picture served")
    check(len(await get(r["url"] + "th/1")) > 0, "thumbnail served")
    wrong = r["url"].rsplit("/", 2)[0] + "/deadbeef/"
    try:
        await get(wrong); check(False, "wrong token must not work")
    except Exception:
        check(True, "wrong token refused")
    try:
        await get(r["url"] + "img/99"); check(False, "unknown picture must not work")
    except Exception:
        check(True, "unknown picture refused")
    try:
        await get(r["url"] + "img/../../etc/passwd"); check(False, "path trick must not work")
    except Exception:
        check(True, "path trick refused")
    st = await pl.phone_status()
    check(st["open"] and st["left"] > 590, "status says open")
    await pl.phone_stop()
    check(not (await pl.phone_status())["open"], "stopped")
    rep = await pl.save_report("hello")
    check(rep["ok"] and open(rep["path"]).read() == "hello", "report saved")

asyncio.run(main_test())
print("backend ok" if not bad else f"{bad} FAILED")
sys.exit(1 if bad else 0)
