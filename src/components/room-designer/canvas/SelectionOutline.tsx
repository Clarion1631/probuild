// Blue wireframe bounding box rendered around the selected AssetNode.
// Kept as its own component so AssetNode doesn't mix selection-visuals with
// geometry resolution.

interface SelectionOutlineProps {
    width: number;
    height: number;
    depth: number;
}

export function SelectionOutline({ width, height, depth }: SelectionOutlineProps) {
    return (
        <mesh renderOrder={999}>
            <boxGeometry args={[width * 1.02, height * 1.02, depth * 1.02]} />
            <meshBasicMaterial color="#2f7dff" wireframe depthTest={false} />
        </mesh>
    );
}
