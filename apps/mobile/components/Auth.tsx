import React, { useState } from 'react';
import { Alert, StyleSheet, View, Text, TextInput, TouchableOpacity, ActivityIndicator } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { router } from 'expo-router';

// This IP usually corresponds to the host machine in the Android Emulator.
// Adjust this to your local IP address if testing on a physical device.
const API_URL = 'http://10.0.2.2:3000/api';

export default function Auth({ onLogin }: { onLogin: (token: string) => void }) {
    const [email, setEmail] = useState('');
    const [pinCode, setPinCode] = useState('');
    const [loading, setLoading] = useState(false);

    async function signIn() {
        if (!email || !pinCode) {
            Alert.alert('Error', 'Please enter your email and PIN code.');
            return;
        }

        setLoading(true);
        try {
            console.log('Attempting login to Next.js API...');
            const res = await fetch(`\${API_URL}/mobile/login`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email, pinCode })
            });

            const data = await res.json();

            if (!res.ok) {
                throw new Error(data.error || 'Authentication failed');
            }

            // Save token and user info
            if (data.token) {
                await AsyncStorage.setItem('next_api_token', data.token);
                await AsyncStorage.setItem('user_info', JSON.stringify(data.user));
                console.log('Login successful, token saved.');
                onLogin(data.token);
                router.replace('/(tabs)');
            } else {
                throw new Error('Token not received from server');
            }

        } catch (error: any) {
            console.error('Login Error:', error);
            Alert.alert('Sign In Error', error.message || 'Could not connect to server.');
        } finally {
            setLoading(false);
        }
    }

    return (
        <View style={styles.container}>
            <Text style={styles.title}>Crew Time Clock</Text>
            <View style={[styles.verticallySpaced, styles.mt20]}>
                <TextInput
                    onChangeText={(text) => setEmail(text)}
                    value={email}
                    placeholder="email@address.com"
                    autoCapitalize={'none'}
                    keyboardType="email-address"
                    style={styles.input}
                    placeholderTextColor="#999"
                />
            </View>
            <View style={styles.verticallySpaced}>
                <TextInput
                    onChangeText={(text) => setPinCode(text)}
                    value={pinCode}
                    secureTextEntry={true}
                    placeholder="6-Digit PIN"
                    keyboardType="number-pad"
                    maxLength={6}
                    style={styles.input}
                    placeholderTextColor="#999"
                />
            </View>
            <View style={[styles.verticallySpaced, styles.mt20]}>
                <TouchableOpacity style={styles.button} disabled={loading} onPress={signIn}>
                    {loading ? (
                        <ActivityIndicator color="white" />
                    ) : (
                        <Text style={styles.buttonText}>Sign In</Text>
                    )}
                </TouchableOpacity>
            </View>
        </View>
    );
}

const styles = StyleSheet.create({
    container: {
        padding: 12,
        flex: 1,
        justifyContent: 'center',
        backgroundColor: '#f5f5f5',
    },
    title: {
        fontSize: 28,
        fontWeight: 'bold',
        marginBottom: 30,
        textAlign: 'center',
        color: '#111827'
    },
    verticallySpaced: {
        paddingTop: 4,
        paddingBottom: 4,
        alignSelf: 'stretch',
    },
    mt20: {
        marginTop: 20,
    },
    input: {
        backgroundColor: 'white',
        padding: 15,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: '#e5e7eb',
        fontSize: 16
    },
    button: {
        backgroundColor: '#2563eb', // Blue-600
        padding: 16,
        borderRadius: 8,
        alignItems: 'center',
        shadowColor: '#2563eb',
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.2,
        shadowRadius: 8,
        elevation: 4
    },
    buttonText: {
        color: 'white',
        fontWeight: 'bold',
        fontSize: 16
    }
});
