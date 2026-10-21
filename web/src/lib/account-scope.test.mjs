import assert from "node:assert/strict";
import test from "node:test";

import {
    GUEST_ACCOUNT_SCOPE,
    accountScope,
    beginTransition,
    capture,
    isCurrent,
    recordKeyBelongsToScope,
    scopedRecordKey,
    scopedStorageKey,
    unscopedRecordKey,
} from "./account-scope.ts";

test("accountScope uses stable user ids and guest fallback", () => {
    assert.equal(accountScope(), GUEST_ACCOUNT_SCOPE);
    assert.equal(accountScope(" 42 "), "user:42");
    assert.equal(accountScope("a/b"), "user:a%2Fb");
});

test("beginTransition invalidates prior captures even for the same account", () => {
    beginTransition();
    const guest = capture();
    const user = beginTransition("42");
    assert.equal(isCurrent(guest), false);
    assert.equal(isCurrent(user), true);
    assert.equal(isCurrent(capture()), true);
    beginTransition("42");
    assert.equal(isCurrent(user), false);
});

test("storage keys are deterministic and scope-separated", () => {
    const guestKey = scopedStorageKey("history", "guest");
    const userKey = scopedStorageKey("history", "user:42");
    assert.equal(guestKey, "history:scope:guest");
    assert.equal(userKey, "history:scope:user:42");
    assert.notEqual(guestKey, userKey);

    const record = scopedRecordKey("log-1", "user:42");
    assert.equal(record, "user:42:log-1");
    assert.equal(recordKeyBelongsToScope(record, "user:42"), true);
    assert.equal(recordKeyBelongsToScope(record, "user:7"), false);
    assert.equal(unscopedRecordKey(record, "user:42"), "log-1");
    assert.equal(unscopedRecordKey("log-1", "user:42"), null);
});
