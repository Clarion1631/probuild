"use client";

interface Item {
    id: string;
    type: string;
    content: string;
    x: number;
    y: number;
    width: number;
    height: number;
    zIndex: number;
}

export default function PortalMoodBoardViewer({ items }: { items: Item[] }) {
    if (items.length === 0) {
        return (
            <div className="w-full h-full flex flex-col items-center justify-center text-slate-400 p-8">
                <svg className="w-16 h-16 mb-4 text-slate-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                </svg>
                <p>This board is currently empty.</p>
            </div>
        );
    }

    return (
        <div className="w-full h-full relative overflow-auto custom-scrollbar" style={{ backgroundImage: 'radial-gradient(#CBD5E1 1px, transparent 1px)', backgroundSize: '20px 20px' }}>
            {items.map(item => (
                <div
                    key={item.id}
                    style={{
                        position: "absolute",
                        left: item.x,
                        top: item.y,
                        width: item.width,
                        height: item.height,
                        zIndex: item.zIndex,
                    }}
                >
                    {item.type === "IMAGE" && (
                        <img src={item.content} alt="Mood Board Content" className="w-full h-full object-contain pointer-events-none" />
                    )}
                    
                    {item.type === "TEXT" && (
                        <div className="w-full h-full p-4 bg-white/80 backdrop-blur shadow-sm border border-slate-200 text-slate-800 text-lg flex items-center justify-center text-center overflow-hidden break-words pointer-events-none rounded-lg">
                            {item.content}
                        </div>
                    )}
                    
                    {item.type === "SWATCH" && (
                        <div className="w-full h-full shadow-sm rounded-lg flex flex-col overflow-hidden pointer-events-none border border-slate-200">
                            <div className="flex-1" style={{ backgroundColor: item.content }} />
                            <div className="h-8 bg-white flex items-center justify-center text-xs font-mono text-slate-600">
                                {item.content}
                            </div>
                        </div>
                    )}
                </div>
            ))}
        </div>
    );
}
