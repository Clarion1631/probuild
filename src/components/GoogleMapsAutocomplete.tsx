"use client";

import { useEffect, useRef } from "react";

interface GoogleMapsAutocompleteProps {
    value: string;
    onChange: (value: string) => void;
    className?: string;
    placeholder?: string;
}

export default function GoogleMapsAutocomplete({ value, onChange, className, placeholder }: GoogleMapsAutocompleteProps) {
    const inputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        const loadGoogleMaps = () => {
            if (!window.google) {
                const script = document.createElement("script");
                script.src = `https://maps.googleapis.com/maps/api/js?key=${process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY || "AIzaSyALTSGHtNgwQNOaK2NL5FgJXzvfmNcu5Xw"}&libraries=places`;
                script.async = true;
                script.onload = initAutocomplete;
                document.head.appendChild(script);
            } else {
                initAutocomplete();
            }
        };

        const initAutocomplete = () => {
            if (!inputRef.current || !window.google) return;
            const autocomplete = new window.google.maps.places.Autocomplete(inputRef.current, {
                types: ["geocode"],
            });
            autocomplete.addListener("place_changed", () => {
                const place = autocomplete.getPlace();
                if (place && place.formatted_address) {
                    onChange(place.formatted_address);
                }
            });
        };

        loadGoogleMaps();
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
