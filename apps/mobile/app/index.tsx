import { Redirect } from 'expo-router'
import { useState, useEffect } from 'react'
import { View, StyleSheet, ActivityIndicator } from 'react-native'
import AsyncStorage from '@react-native-async-storage/async-storage'
import Auth from '../components/Auth'

export default function Index() {
    const [token, setToken] = useState<string | null>(null)
    const [loading, setLoading] = useState(true)

    useEffect(() => {
        AsyncStorage.getItem('next_api_token').then(t => {
            setToken(t)
            setLoading(false)
        })
    }, [])

    if (loading) {
        return (
            <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
                <ActivityIndicator size="large" />
            </View>
        )
    }

    if (token) {
        return <Redirect href="/(tabs)" />
    }

    return (
        <View style={styles.container}>
            <Auth onLogin={(t: string) => setToken(t)} />
        </View>
    )
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: '#f5f5f5',
        justifyContent: 'center',
        padding: 20,
    },
})
