interface AvatarProps {
    name: string;
    color?: "blue" | "green" | "orange" | "purple" | "pink";
}

export default function Avatar({ name, color = "blue" }: AvatarProps) {
    const getInitials = (name: string) => {
        return name
            .split(" ")
            .map((n) => n[0])
            .slice(0, 2)
            .join("")
            .toUpperCase();
    };

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

    const colorClass = getColors(color);

    return (
        <div className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-semibold ${colorClass}`}>
            {getInitials(name)}
        </div>
    );
}
