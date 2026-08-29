/**
 * ShipAddr sent with a pushed QBO milestone invoice.
 *
 * QBO Automated Sales Tax rates an invoice by its ShipAddr. Without one it uses
 * the company address (Vancouver), which rated Berg ADU (Winlock, 8.0%) at 8.9%
 * on INV-00177-2 (2026-07). qbShipAddrFor turns the project's free-text
 * location (or the client's structured address) into the address QBO needs.
 * Anything short of street + WA zip yields null — send nothing — because a
 * partial address can steer AST to a wrong jurisdiction, which is worse than
 * the company default.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { qbShipAddrFor } from "../src/lib/wa-tax";

const winlockClient = { addressLine1: "204 SW Kerron St", city: "Winlock", state: "wa", zipCode: "98596-1234" };

test("project location with street, city and zip → structured WA address", () => {
    assert.deepEqual(qbShipAddrFor("219 Jones Rd, Winlock, WA 98596, USA"), {
        Line1: "219 Jones Rd",
        City: "Winlock",
        CountrySubDivisionCode: "WA",
        PostalCode: "98596",
    });
});

test("comma-less location still yields street + zip", () => {
    const addr = qbShipAddrFor("2810 Unander Ave Vancouver WA 98660");
    assert.equal(addr?.PostalCode, "98660");
    assert.equal(addr?.CountrySubDivisionCode, "WA");
    assert.match(addr?.Line1 ?? "", /^2810 Unander Ave/);
});

test("project-name-prefixed location has no street → falls back to the client", () => {
    assert.deepEqual(qbShipAddrFor("Berg ADU, 204 SW Kerron St, Winlock, WA 98596", winlockClient), {
        Line1: "204 SW Kerron St",
        City: "Winlock",
        CountrySubDivisionCode: "WA",
        PostalCode: "98596",
    });
});

test("unparseable location + valid client address → client wins", () => {
    assert.equal(qbShipAddrFor("Shop", winlockClient)?.Line1, "204 SW Kerron St");
});

test("unparseable location and no usable client address → null (no ShipAddr sent)", () => {
    assert.equal(qbShipAddrFor("Shop"), null);
    assert.equal(qbShipAddrFor("Shop", { addressLine1: null, city: "Vancouver", state: "WA", zipCode: "98660" }), null);
    assert.equal(qbShipAddrFor(null, { addressLine1: "1 Main St", city: "Vancouver", state: "WA", zipCode: null }), null);
    assert.equal(qbShipAddrFor(null, null), null);
});

test("WA zip range is exact: 98001–99403", () => {
    const at = (zip: string) => qbShipAddrFor(`1 Main St, Somewhere, WA ${zip}`)?.PostalCode ?? null;
    assert.equal(at("98000"), null);
    assert.equal(at("98001"), "98001");
    assert.equal(at("99403"), "99403");
    assert.equal(at("99404"), null);
});

test("out-of-state client address is not labeled WA", () => {
    assert.equal(qbShipAddrFor(null, { addressLine1: "1 Main St", city: "Portland", state: "OR", zipCode: "97201" }), null);
    // Alaska-shaped zip slips through parseLocationText's 98/99 match — reject it here.
    assert.equal(qbShipAddrFor("100 W 4th Ave, Anchorage, AK 99501"), null);
    assert.equal(qbShipAddrFor(null, { addressLine1: "100 W 4th Ave", city: "Anchorage", state: "", zipCode: "99501" }), null);
});
