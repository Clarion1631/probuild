import { Stack } from 'expo-router';

export default function ManagerLayout() {
    return (
        <Stack screenOptions={{ headerShown: false }}>
            <Stack.Screen name="index" options={{ title: 'Manager Dashboard' }} />
            <Stack.Screen name="jobs/index" options={{ title: 'Jobs' }} />
            <Stack.Screen name="jobs/[id]" options={{ title: 'Job Details' }} />
        </Stack>
    );
}
