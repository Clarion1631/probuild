"use client";

declare global {
    interface Window {
        google: any;
        initGooglePlaces: (() => void) | undefined;
    }
}

import { useEffect, useRef, useState } from "react";

interface GoogleMapsAutocompleteProps {
    value: string;
    onChange: (value: string) => void;
    onPlaceDetails?: (details: { address: string; city: string; state: string; zip: string }) => void;
    className?: string;
    placeholder?: string;
}

// Singleton loader — prevents duplicate script tags and race conditions when
// multiple autocomplete instances mount concurrently.
// I1: Promise rejects on script error and resets so next mount can retry.
// I2: Checks for existing script tag by id before appending.
let googleMapsPromise: Promise<void> | null = null;

const SCRIPT_ID = "google-maps-js";

function loadGoogleMapsScript(): Promise<void> {
    if (typeof window === "undefined") return Promise.resolve();
    if (window.google?.maps) return Promise.resolve();

    // I2: If the tag already exists (e.g. after Fast Refresh), attach to its events
    const existing = document.getElementById(SCRIPT_ID) as HTMLScriptElement | null;

    if (!googleMapsPromise) {
        googleMapsPromise = new Promise<void>((resolve, reject) => {
            // I1: expose global callback
            window.initGooglePlaces = () => {
                delete window.initGooglePlaces;
                resolve();
            };

            if (existing) {
                // Script tag already in DOM — listen for it
                existing.addEventListener("load", () => resolve());
                existing.addEventListener("error", () => {
                    googleMapsPromise = null; // allow retry
                    reject(new Error("Google Maps script failed to load"));
                });
                return;
            }

            const script = document.createElement("script");
            script.id = SCRIPT_ID;
            const key = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY?.trim();
            script.src = `https://maps.googleapis.com/maps/api/js?key=${key}&libraries=places&callback=initGooglePlaces`;
            script.async = true;
            script.defer = true;
            // I1: reject + reset on load failure so next mount can retry
            script.onerror = () => {
                googleMapsPromise = null;
                reject(new Error("Google Maps script failed to load"));
            };
            document.head.appendChild(script);
        });
    }

    return googleMapsPromise;
}

export default function GoogleMapsAutocomplete({
    value,
    onChange,
    onPlaceDetails,
    className,
    placeholder,
}: GoogleMapsAutocompleteProps) {
    const inputRef = useRef<HTMLInputElement>(null);
    const [mapsError, setMapsError] = useState(false);

    // I3: Store callbacks in refs so Autocomplete is initialised once per mount,
    // not recreated whenever the parent passes a new function reference.
    const onChangeRef = useRef(onChange);
    const onPlaceDetailsRef = useRef(onPlaceDetails);
    useEffect(() => { onChangeRef.current = onChange; }, [onChange]);
    useEffect(() => { onPlaceDetailsRef.current = onPlaceDetails; }, [onPlaceDetails]);

    useEffect(() => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let listener: any = null;
        let cancelled = false;

        loadGoogleMapsScript()
            .then(() => {
                if (cancelled || !inputRef.current || !window.google) return;

                const autocomplete = new window.google.maps.places.Autocomplete(inputRef.current, {
                    types: ["geocode"],
                });

                // I3: keep single listener per mount; cleaned up on unmount
                listener = autocomplete.addListener("place_changed", () => {
                    const place = autocomplete.getPlace();
                    if (!place?.formatted_address) return;

                    onChangeRef.current(place.formatted_address);

                    if (onPlaceDetailsRef.current && place.address_components) {
                        let street_number = "";
                        let route = "";
                        let city = "";
                        let state = "";
                        let zip = "";

                        for (const component of place.address_components) {
                            const componentType = component.types[0];
                            if (componentType === "street_number") street_number = component.long_name;
                            if (componentType === "route") route = component.long_name;
                            if (componentType === "locality" || componentType === "postal_town") city = component.long_name;
                            if (componentType === "administrative_area_level_1") state = component.short_name;
                            if (componentType === "postal_code") zip = component.long_name;
                        }

                        onPlaceDetailsRef.current({
                            address: `${street_number} ${route}`.trim(),
                            city,
                            state,
                            zip,
                        });
                    }
                });
            })
            .catch(() => {
                if (!cancelled) setMapsError(true);
            });

        // I3: cleanup on unmount removes listener, prevents stale handler leaks
        return () => {
            cancelled = true;
            if (listener) {
                window.google?.maps?.event?.removeListener(listener);
                listener = null;
            }
        };
    }, []); // empty deps — init once per mount; callbacks stay fresh via refs

    return (
        <div className="w-full">
            <input
                ref={inputRef}
                type="text"
                value={value}
                onChange={(e) => onChangeRef.current(e.target.value)}
                className={className}
                placeholder={placeholder}
            />
            {mapsError && (
                <p className="text-xs text-amber-600 mt-1">Address lookup unavailable — type address manually.</p>
            )}
        </div>
    );
}
