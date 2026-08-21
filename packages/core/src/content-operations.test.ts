// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";
import {
  contentLocale,
  resolveLocalizedCurrent,
} from "./content-operations.js";

test("content locale is English by default and accepts only zh-CN", () => {
  assert.equal(contentLocale(undefined), "en");
  assert.equal(contentLocale("en"), "en");
  assert.equal(contentLocale("zh-CN"), "zh-CN");
  assert.equal(contentLocale("zh"), "en");
});

test("localized current resolution prefers the request and falls back only to English", () => {
  const en = { locale: "en" as const, value: "English" };
  const zh = { locale: "zh-CN" as const, value: "Chinese" };
  assert.equal(resolveLocalizedCurrent("zh-CN", [en, zh]), zh);
  assert.equal(resolveLocalizedCurrent("zh-CN", [en]), en);
  assert.equal(resolveLocalizedCurrent("en", [zh]), null);
  assert.equal(resolveLocalizedCurrent("en", [zh, en]), en);
});
