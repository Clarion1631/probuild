import { getSelectionBoards } from "@/lib/actions";
import SelectionsClient from "./SelectionsClient";

export default async function SelectionsPage(props: { params: Promise<{ id: string }> }) {
    const { id } = await props.params;
    const boards = await getSelectionBoards(id);

    return <SelectionsClient projectId={id} initialBoards={JSON.parse(JSON.stringify(boards))} />;
}
