"use client";

export default function GoogleMapPreview({ address }: { address: string }) {
    if (!address || address.trim() === "") return null;

    const apiKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;
    if (!apiKey) return null;
    const embedUrl = `https://www.google.com/maps/embed/v1/place?key=${apiKey}&q=${encodeURIComponent(address)}`;

    return (
        <div className="w-full h-40 mt-3 rounded-lg overflow-hidden border border-slate-200">
            <iframe
                width="100%"
                height="100%"
                frameBorder="0"
                style={{ border: 0 }}
                src={embedUrl}
                allowFullScreen
            ></iframe>
        </div>
    );
}
