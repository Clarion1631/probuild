import { Stack, useRouter, useSegments } from 'expo-router';
import { useEffect, useState } from 'react';
import { View, ActivityIndicator } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFonts } from 'expo-font';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import * as SplashScreen from 'expo-splash-screen';
import AsyncStorage from '@react-native-async-storage/async-storage';

// Prevent the splash screen from auto-hiding before asset loading is complete.
SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
    const [token, setToken] = useState<string | null>(null);
    const [initialized, setInitialized] = useState(false);
    const [fontsLoaded] = useFonts({
        ...MaterialIcons.font,
    });
    const router = useRouter();
    const segments = useSegments();

    // 1. Session State Management
    useEffect(() => {
        // Simple check for the Next.js API token
        AsyncStorage.getItem('next_api_token').then(t => {
            setToken(t);
            setInitialized(true);
        });
    }, []);

    // 2. Navigation Sync
    useEffect(() => {
        if (!initialized) return;
        const inAuthGroup = segments[0] === '(tabs)';
        if (!token && inAuthGroup) {
            router.replace('/');
        } else if (token && !segments[0]) {
            router.replace('/(tabs)');
        }
    }, [token, initialized, segments]);

    // 3. Splash Screen
    useEffect(() => {
        if (initialized && fontsLoaded) {
            SplashScreen.hideAsync();
        }
    }, [initialized, fontsLoaded]);

    return (
        <SafeAreaProvider>
            <RootLayoutContent token={token} initialized={initialized} fontsLoaded={fontsLoaded} />
        </SafeAreaProvider>
    );
}

function RootLayoutContent({ token, initialized, fontsLoaded }: { token: string | null, initialized: boolean, fontsLoaded: boolean }) {
    const insets = useSafeAreaInsets();

    if (!initialized || !fontsLoaded) {
        return (
            <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
                <ActivityIndicator size="large" />
            </View>
        );
    }

    return (
        <View style={{ flex: 1, backgroundColor: '#f5f5f5' }}>
            <View style={{ height: insets.top, backgroundColor: '#111827' }} />
            <StatusBar style="light" backgroundColor="#111827" />
            <Stack screenOptions={{ headerShown: false }}>
                <Stack.Screen name="index" />
                <Stack.Screen name="(tabs)" />
            </Stack>
        </View>
    );
}
