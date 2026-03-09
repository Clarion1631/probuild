import React, { useState, useEffect } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Alert, ActivityIndicator, Modal, FlatList } from 'react-native';
import * as Location from 'expo-location';
import { api } from '../lib/api';

type Project = {
    id: string;
    name: string;
};

type Bucket = {
    id: string;
    name: string;
};

type TimeEntry = {
    id: string;
    startTime: string;
    endTime?: string | null;
    project: { name: string };
    budgetBucket?: { name: string } | null;
};

export default function TimeClock({ token, userInfo }: { token: string; userInfo: any }) {
    const [loading, setLoading] = useState(false);
    const [projects, setProjects] = useState<Project[]>([]);
    const [buckets, setBuckets] = useState<Bucket[]>([]);

    const [selectedProjectId, setSelectedProjectId] = useState<string>('');
    const [selectedBucketId, setSelectedBucketId] = useState<string>('');

    const [activeEntry, setActiveEntry] = useState<TimeEntry | null>(null);
    const [duration, setDuration] = useState<string>('--:--:--');
    const [locationPermission, setLocationPermission] = useState<boolean | null>(null);

    // Modal State
    const [modalVisible, setModalVisible] = useState(false);
    const [modalType, setModalType] = useState<'project' | 'bucket'>('project');

    useEffect(() => {
        fetchProjects();
        fetchActiveEntry();
        checkLocationPermissions();
    }, []);

    useEffect(() => {
        if (selectedProjectId) {
            fetchBuckets(selectedProjectId);
        } else {
            setBuckets([]);
            setSelectedBucketId('');
        }
    }, [selectedProjectId]);

    useEffect(() => {
        let interval: any;

        const updateTimer = () => {
            if (activeEntry && activeEntry.startTime && !activeEntry.endTime) {
                const start = new Date(activeEntry.startTime).getTime();
                const now = new Date().getTime();
                const diff = Math.max(0, now - start);

                const hours = Math.floor(diff / (1000 * 60 * 60));
                const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
                const seconds = Math.floor((diff % (1000 * 60)) / 1000);

                setDuration(
                    `\${hours.toString().padStart(2, '0')}:\${minutes.toString().padStart(2, '0')}:\${seconds.toString().padStart(2, '0')}`
                );
            } else {
                setDuration('--:--:--');
            }
        };

        if (activeEntry) {
            updateTimer();
            interval = setInterval(updateTimer, 1000);
        }
        return () => clearInterval(interval);
    }, [activeEntry]);

    async function checkLocationPermissions() {
        let { status } = await Location.requestForegroundPermissionsAsync();
        setLocationPermission(status === 'granted');
    }

    async function fetchProjects() {
        try {
            const data = await api.getProjects();
            setProjects(data);
        } catch (error) {
            console.error('Fetch Projects Error:', error);
        }
    }

    async function fetchBuckets(projectId: string) {
        try {
            const data = await api.getProjectBuckets(projectId);
            setBuckets(data);
        } catch (error) {
            console.error('Fetch Buckets Error:', error);
        }
    }

    async function fetchActiveEntry() {
        try {
            const entries = await api.getTimeEntries();
            const active = entries.find((e: any) => e.endTime === null);
            setActiveEntry(active || null);
        } catch (error) {
            console.error('Fetch Active Entry Error:', error);
        }
    }

    async function getLocation() {
        if (!locationPermission) return null;
        try {
            let lastKnown = await Location.getLastKnownPositionAsync();
            if (lastKnown) return { lat: lastKnown.coords.latitude, lng: lastKnown.coords.longitude };
            const location = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
            return { lat: location.coords.latitude, lng: location.coords.longitude };
        } catch (err) {
            return null;
        }
    }

    async function handleClockIn() {
        if (!selectedProjectId) {
            Alert.alert('Validation', 'Please select a project first');
            return;
        }

        setLoading(true);
        try {
            const loc = await getLocation();
            const entry = await api.clockIn({
                projectId: selectedProjectId,
                budgetBucketId: selectedBucketId || undefined,
                latitude: loc?.lat,
                longitude: loc?.lng
            });
            // Refetch active entry nicely to get all relations
            await fetchActiveEntry();
        } catch (err: any) {
            Alert.alert('Clock In Error', err.message);
        } finally {
            setLoading(false);
        }
    }

    async function handleClockOut() {
        if (!activeEntry) return;

        setLoading(true);
        try {
            const loc = await getLocation();
            await api.clockOut({
                id: activeEntry.id,
                latitude: loc?.lat,
                longitude: loc?.lng
            });
            setActiveEntry(null);
            setDuration('--:--:--');
            setSelectedProjectId('');
            setSelectedBucketId('');
        } catch (err: any) {
            Alert.alert('Clock Out Error', err.message);
        } finally {
            setLoading(false);
        }
    }

    const openProjectSelector = () => {
        setModalType('project');
        setModalVisible(true);
    };

    const openBucketSelector = () => {
        if (!selectedProjectId) return Alert.alert('First', 'Please select a project');
        setModalType('bucket');
        setModalVisible(true);
    };

    const handleSelect = (item: any) => {
        if (modalType === 'project') {
            setSelectedProjectId(item.id);
            setModalVisible(false);
            // Auto open phase next if they have any? We'll leave out for simplicity
        } else {
            setSelectedBucketId(item.id);
            setModalVisible(false);
        }
    };

    const activeProjectName = activeEntry?.project?.name || 'Unknown Project';
    const activeBucketName = activeEntry?.budgetBucket?.name || '';
    const selectedProjectName = projects.find(p => p.id === selectedProjectId)?.name || 'Select a Project...';
    const selectedBucketName = buckets.find(b => b.id === selectedBucketId)?.name || 'Select a Phase...';
    const dataToRender = modalType === 'project' ? projects : buckets;

    return (
        <View style={styles.card}>
            <View style={styles.header}>
                <Text style={styles.title}>Time Clock</Text>
                <View style={[styles.badge, activeEntry ? styles.badgeActive : styles.badgeInactive]}>
                    <Text style={[styles.badgeText, activeEntry ? styles.badgeTextActive : styles.badgeTextInactive]}>
                        {activeEntry ? 'CLOCKED IN' : 'OFF CLOCK'}
                    </Text>
                </View>
            </View>

            <View style={styles.timerContainer}>
                <Text style={styles.timer}>{duration}</Text>
                {activeEntry && (
                    <View style={{ alignItems: 'center' }}>
                        <Text style={styles.subtext}>{activeProjectName}</Text>
                        {!!activeBucketName && <Text style={styles.phaseText}>{activeBucketName}</Text>}
                    </View>
                )}
            </View>

            {!activeEntry ? (
                <View style={styles.controls}>
                    <Text style={styles.label}>Project</Text>
                    <TouchableOpacity style={styles.selector} onPress={openProjectSelector}>
                        <Text style={{ color: selectedProjectId ? '#000' : '#888' }}>{selectedProjectName}</Text>
                        <Text style={styles.chevron}>▼</Text>
                    </TouchableOpacity>

                    {buckets.length > 0 && (
                        <>
                            <Text style={[styles.label, { marginTop: 15 }]}>Phase (Optional)</Text>
                            <TouchableOpacity style={styles.selector} onPress={openBucketSelector}>
                                <Text style={{ color: selectedBucketId ? '#000' : '#888' }}>{selectedBucketName}</Text>
                                <Text style={styles.chevron}>▼</Text>
                            </TouchableOpacity>
                        </>
                    )}

                    <TouchableOpacity style={[styles.mainBtn, styles.clockInBtn, loading && { opacity: 0.7 }]} onPress={handleClockIn} disabled={loading}>
                        {loading ? <ActivityIndicator color="#fff" /> : <Text style={styles.mainBtnText}>CLOCK IN</Text>}
                    </TouchableOpacity>
                </View>
            ) : (
                <View style={styles.controls}>
                    <TouchableOpacity style={[styles.mainBtn, styles.clockOutBtn, loading && { opacity: 0.7 }]} onPress={handleClockOut} disabled={loading}>
                        {loading ? <ActivityIndicator color="#fff" /> : <Text style={styles.mainBtnText}>CLOCK OUT</Text>}
                    </TouchableOpacity>
                </View>
            )}

            <Modal
                animationType="slide"
                transparent={true}
                visible={modalVisible}
                onRequestClose={() => setModalVisible(false)}
            >
                <View style={styles.modalBg}>
                    <View style={styles.modalContent}>
                        <Text style={styles.modalTitle}>Select {modalType === 'project' ? 'Project' : 'Phase'}</Text>
                        <FlatList
                            data={dataToRender}
                            keyExtractor={item => item.id}
                            renderItem={({ item }) => (
                                <TouchableOpacity style={styles.modalItem} onPress={() => handleSelect(item)}>
                                    <Text style={styles.modalItemText}>{item.name}</Text>
                                </TouchableOpacity>
                            )}
                            ListEmptyComponent={<Text style={{ padding: 20, textAlign: 'center', color: '#666' }}>No options available.</Text>}
                        />
                        <TouchableOpacity style={styles.closeBtn} onPress={() => setModalVisible(false)}>
                            <Text style={styles.closeBtnText}>Cancel</Text>
                        </TouchableOpacity>
                    </View>
                </View>
            </Modal>
        </View>
    );
}

const styles = StyleSheet.create({
    card: { backgroundColor: '#fff', borderRadius: 12, padding: 20, elevation: 3, shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.1, shadowRadius: 8 },
    header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 },
    title: { fontSize: 20, fontWeight: 'bold', color: '#111827' },
    badge: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 20 },
    badgeActive: { backgroundColor: '#dcfce7' },
    badgeInactive: { backgroundColor: '#f1f5f9' },
    badgeText: { fontSize: 12, fontWeight: 'bold' },
    badgeTextActive: { color: '#166534' },
    badgeTextInactive: { color: '#64748b' },
    timerContainer: { alignItems: 'center', marginVertical: 30 },
    timer: { fontSize: 48, fontWeight: '700', color: '#111827', fontFamily: 'monospace' },
    subtext: { fontSize: 16, color: '#4b5563', marginTop: 10, fontWeight: '600' },
    phaseText: { fontSize: 14, color: '#6b7280', marginTop: 4 },
    controls: { marginTop: 10 },
    label: { fontSize: 14, fontWeight: '600', color: '#374151', marginBottom: 8 },
    selector: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', borderWidth: 1, borderColor: '#d1d5db', borderRadius: 8, padding: 16, backgroundColor: '#f9fafb' },
    chevron: { color: '#9ca3af', fontSize: 12 },
    mainBtn: { borderRadius: 8, padding: 18, alignItems: 'center', marginTop: 30 },
    clockInBtn: { backgroundColor: '#16a34a' },
    clockOutBtn: { backgroundColor: '#dc2626' },
    mainBtnText: { color: '#fff', fontSize: 16, fontWeight: 'bold', letterSpacing: 1 },
    modalBg: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
    modalContent: { backgroundColor: '#fff', borderTopLeftRadius: 20, borderTopRightRadius: 20, maxHeight: '80%', padding: 20 },
    modalTitle: { fontSize: 18, fontWeight: 'bold', marginBottom: 15, color: '#111827', textAlign: 'center' },
    modalItem: { paddingVertical: 15, borderBottomWidth: 1, borderBottomColor: '#f3f4f6' },
    modalItemText: { fontSize: 16, color: '#374151' },
    closeBtn: { marginTop: 20, backgroundColor: '#f3f4f6', padding: 15, borderRadius: 8, alignItems: 'center' },
    closeBtnText: { color: '#4b5563', fontWeight: 'bold' }
});
