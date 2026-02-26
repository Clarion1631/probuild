import { useEffect } from 'react';
import { View, Text } from 'react-native';
import { useRouter } from 'expo-router';

export default function AuthCallback() {
    const router = useRouter();

    useEffect(() => {
        // The WebBrowser session in Auth.tsx typically handles the token exchange
        // via the deep link listener. 
        // This route mainly exists to prevent "Unmatched Route" errors 
        // and to redirect back to the main app if the user lands here.

        // Slight delay to allow Auth.tsx to process the token if it needs to
        const timer = setTimeout(() => {
            router.replace('/');
        }, 100);

        return () => clearTimeout(timer);
    }, []);

    return (
        <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
            <Text>Completing Sign In...</Text>
        </View>
    );
}
