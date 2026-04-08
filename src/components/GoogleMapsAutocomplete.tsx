"use client";

declare global {
    interface Window {
        google: any;
        initGooglePlaces: () => void;
    }
}

import { useEffect, useRef } from "react";

interface GoogleMapsAutocompleteProps {
    value: string;
    onChange: (value: string) => void;
    onPlaceDetails?: (details: { address: string, city: string, state: string, zip: string }) => void;
    className?: string;
    placeholder?: string;
}

// Singleton loader — prevents duplicate script tags and race conditions when
// multiple autocomplete instances mount concurrently.
let googleMapsPromise: Promise<void> | null = null;

function loadGoogleMapsScript(): Promise<void> {
    if (typeof window === "undefined") return Promise.resolve();
    if (window.google?.maps) return Promise.resolve();
    if (googleMapsPromise) return googleMapsPromise;

    googleMapsPromise = new Promise((resolve) => {
        window.initGooglePlaces = resolve;
        const script = document.createElement("script");
        const key = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY?.trim();
        script.src = `https://maps.googleapis.com/maps/api/js?key=${key}&libraries=places&callback=initGooglePlaces`;
        script.async = true;
        script.defer = true;
        document.head.appendChild(script);
    });

    return googleMapsPromise;
}

export default function GoogleMapsAutocomplete({ value, onChange, onPlaceDetails, className, placeholder }: GoogleMapsAutocompleteProps) {
    const inputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        const initAutocomplete = () => {
            if (!inputRef.current || !window.google) return;
            const autocomplete = new window.google.maps.places.Autocomplete(inputRef.current, {
                types: ["geocode"],
            });
            autocomplete.addListener("place_changed", () => {
                const place = autocomplete.getPlace();
                if (place && place.formatted_address) {
                    onChange(place.formatted_address);

                    if (onPlaceDetails && place.address_components) {
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

                        onPlaceDetails({
                            address: `${street_number} ${route}`.trim(),
                            city,
                            state,
                            zip
                        });
                    }
                }
            });
        };

        loadGoogleMapsScript().then(initAutocomplete);
    }, [onChange]);

    return (
        <input
            ref={inputRef}
            type="text"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            className={className}
            placeholder={placeholder}
        />
    );
}
