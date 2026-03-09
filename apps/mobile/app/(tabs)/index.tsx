import { View, ScrollView, StyleSheet, RefreshControl, Text } from 'react-native';
import React, { useState, useEffect, useCallback } from 'react';
import TimeClock from '@/components/TimeClock';
import { useFocusEffect, router } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';

export default function HomeScreen() {
  const [token, setToken] = useState<string | null>(null);
  const [userInfo, setUserInfo] = useState<any>(null);
  const [isManager, setIsManager] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  useFocusEffect(
    useCallback(() => {
      getSession();
    }, [])
  );

  async function getSession() {
    const t = await AsyncStorage.getItem('next_api_token');
    const uStr = await AsyncStorage.getItem('user_info');
    setToken(t);
    if (uStr) {
      const u = JSON.parse(uStr);
      setUserInfo(u);
      setIsManager(u.role === 'MANAGER' || u.role === 'ADMIN');
    }
  }

  const onRefresh = async () => {
    setRefreshing(true);
    await getSession();
    setRefreshing(false);
  };

  if (!token) {
    return (
      <View style={styles.container}>
        <Text>Please Log In</Text>
      </View>
    );
  }

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={{ paddingBottom: 40 }}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
      }
    >
      <View style={styles.section}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
          <Text style={{ fontSize: 20, fontWeight: 'bold' }}>Dashboard {userInfo?.name && `- \${userInfo.name}`}</Text>
          <Text
            onPress={async () => {
              try {
                await AsyncStorage.removeItem('next_api_token');
                await AsyncStorage.removeItem('user_info');
              } catch (e) {
                console.error('SignOut Failed:', e);
              } finally {
                if (router.canDismiss()) {
                  router.dismissAll();
                }
                router.replace('/');
              }
            }}
            style={{ color: 'red', fontWeight: 'bold' }}
          >
            Sign Out
          </Text>
        </View>
        <TimeClock token={token} userInfo={userInfo} />
      </View >
    </ScrollView >
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f3f4f6',
    padding: 16,
    paddingTop: 60
  },
  section: {
    marginBottom: 20
  }
});
