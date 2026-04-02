interface AvatarProps {
    name?: string;
    initials?: string;
    color?: "blue" | "green" | "orange" | "purple" | "pink";
    size?: "sm" | "md" | "lg" | "xl";
}

export default function Avatar({ name, initials, color = "blue", size = "md" }: AvatarProps) {
    const getInitials = (nameToParse: string) => {
        return nameToParse
            .split(" ")
            .map((n) => n[0])
            .slice(0, 2)
            .join("")
            .toUpperCase();
    };

    const displayInitials = initials || (name ? getInitials(name) : "?");

    const getColors = (c: string) => {
        switch (c) {
            case "green":
                return "bg-green-500 text-white";
            case "orange":
                return "bg-orange-500 text-white";
            case "purple":
                return "bg-purple-500 text-white";
            case "pink":
                return "bg-pink-500 text-white";
            case "blue":
            default:
                return "bg-blue-500 text-white";
        }
    };

    const getSize = (s: string) => {
        switch (s) {
            case "sm": return "w-6 h-6 text-[10px]";
            case "lg": return "w-12 h-12 text-lg";
            case "xl": return "w-16 h-16 text-xl";
            case "md":
            default:
                return "w-8 h-8 text-xs";
        }
    };

    const colorClass = getColors(color);
    const sizeClass = getSize(size);

    return (
        <div className={`${sizeClass} rounded-full flex items-center justify-center font-semibold ${colorClass}`}>
            {displayInitials}
        </div>
    );
}

