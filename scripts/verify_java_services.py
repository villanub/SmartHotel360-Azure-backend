"""Check legacy service contracts against disposable runner-local PostgreSQL."""
import json
import os
import pathlib
import subprocess
import time
import urllib.error
import urllib.request
import zipfile

from playwright.sync_api import sync_playwright


def request(url, method="GET"):
    with urllib.request.urlopen(urllib.request.Request(url, method=method), timeout=10) as response:
        return json.load(response)


with sync_playwright() as playwright:
    browser = playwright.chromium.launch()
    try:
        for service in ("Tasks", "Reviews"):
            directory = pathlib.Path("src") / ("SmartHotel.Services." + service)
            jar = next(directory.glob("target/*-SNAPSHOT.jar"))
            with zipfile.ZipFile(jar) as archive:
                names = archive.namelist()
                for library in ("postgresql-42.2.28.jar", "springfox-swagger2-2.9.2.jar", "springfox-swagger-ui-2.10.0.jar"):
                    assert "BOOT-INF/lib/" + library in names, library
                assert not any("springfox-swagger-ui-2.6.1" in name for name in names)
            initial_count = None
            for context in ("", "/compat"):
                environment = dict(os.environ, sql_server_url="jdbc:postgresql://127.0.0.1:5432/" + service.lower(),
                                   sql_user_name="postgres", sql_user_password="postgres", PATH_BASE=context)
                with open(service + "-startup.log", "w") as log:
                    process = subprocess.Popen(["java", "-jar", str(jar), "--server.port=8080"], env=environment, stdout=log, stderr=log)
                    try:
                        base = "http://127.0.0.1:8080" + context
                        for attempt in range(90):
                            try:
                                resources = request(base + "/swagger-resources")
                                break
                            except (OSError, ValueError):
                                if process.poll() is not None:
                                    raise AssertionError(pathlib.Path(service + "-startup.log").read_text())
                                time.sleep(1)
                        else:
                            raise AssertionError("Service startup timed out")
                        assert resources and all(item.get("url") for item in resources)
                        spec = request(base + "/v2/api-docs")
                        assert spec["paths"]
                        request(base + "/swagger-resources/configuration/ui")
                        request(base + "/swagger-resources/configuration/security")
                        endpoint = "/tasks" if service == "Tasks" else "/reviews/hotel/1"
                        records = request(base + endpoint)
                        assert records
                        if initial_count is None:
                            initial_count = len(records)
                        else:
                            assert len(records) == initial_count, "Restart duplicated seeds"
                        if service == "Tasks":
                            assert len(records) == 15
                            identity = str(records[0]["id"])
                            assert request(base + "/tasks/resolved/" + identity, "PUT")["resolved"] is True
                            assert request(base + "/tasks/pending/" + identity, "PUT")["resolved"] is False
                            assert all(not item["resolved"] for item in request(base + "/tasks/pending"))
                            try:
                                request(base + "/tasks/resolved/2147483647", "PUT")
                            except urllib.error.HTTPError as error:
                                assert error.code == 404
                            else:
                                raise AssertionError("Missing task did not return 404")
                        else:
                            assert all(item["hotelId"] == 1 for item in records)
                            assert [item["submitted"] for item in records] == sorted((item["submitted"] for item in records), reverse=True)
                        page = browser.new_page()
                        errors = []
                        page.on("pageerror", lambda error: errors.append(str(error)))
                        page.goto(base + "/swagger-ui.html")
                        # The existing UI configuration starts controller groups collapsed.
                        page.locator(".opblock-tag").first.click()
                        try:
                            page.locator(".opblock").first.wait_for(timeout=30000)
                        except Exception:
                            print("Swagger diagnostic:", resources, spec.get("swagger"), spec.get("info"), errors, page.locator("body").inner_text(), flush=True)
                            raise
                        assert not errors, errors
                        operation = page.locator(".opblock-get").filter(has=page.locator('[data-path="' + ("/tasks" if service == "Tasks" else "/reviews/hotel/{id}") + '"]')).first
                        operation.locator(".opblock-summary").click()
                        operation.get_by_role("button", name="Try it out").click()
                        if service == "Reviews":
                            operation.locator(".parameters-col_description input").fill("1")
                        operation.get_by_role("button", name="Execute", exact=True).click()
                        operation.locator(".live-responses-table .response-col_status").filter(has_text="200").wait_for()
                        page.close()
                        print(service, context or "/", "contracts, Swagger rendering and request execution passed", flush=True)
                    finally:
                        process.terminate()
                        process.wait(timeout=30)
    finally:
        browser.close()
