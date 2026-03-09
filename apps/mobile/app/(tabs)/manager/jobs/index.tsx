import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, FlatList, TouchableOpacity, ActivityIndicator } from 'react-native';
import { supabase } from '@/lib/supabase';
import { useRouter } from 'expo-router';
import { IconSymbol } from '@/components/ui/icon-symbol';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Modal, TextInput, Alert } from 'react-native';
import * as Location from 'expo-location';
import AddressAutocomplete from '@/components/AddressAutocomplete';

export default function JobListScreen() {
    const [jobs, setJobs] = useState<any[]>([]);
    const [loading, setLoading] = useState(true);
    const [modalVisible, setModalVisible] = useState(false);
    const [newJobName, setNewJobName] = useState('');
    const [newJobAddress, setNewJobAddress] = useState('');
    const [newJobCoords, setNewJobCoords] = useState<{ lat: number | null, lng: number | null }>({ lat: null, lng: null });
    const [saving, setSaving] = useState(false);

    const router = useRouter();
    const insets = useSafeAreaInsets();

    useEffect(() => {
        fetchJobs();
    }, []);

    async function fetchJobs() {
        setLoading(true);
        const { data, error } = await supabase
            .from('jobs')
            .select('*')
            .eq('status', 'active')
            .order('name');

        if (data) setJobs(data);
        setLoading(false);
    }

    async function addJob() {
        if (!newJobName.trim()) {
            Alert.alert('Required', 'Please enter a job name.');
            return;
        }

        setSaving(true);

        let lat = newJobCoords.lat;
        let lng = newJobCoords.lng;

        // Fallback geocoding if coords are missing but address exists (unlikely with autocomplete)
        if (!lat && newJobAddress.trim()) {
            try {
                const geo = await Location.geocodeAsync(newJobAddress.trim());
                if (geo && geo.length > 0) {
                    lat = geo[0].latitude;
                    lng = geo[0].longitude;
                }
            } catch (e) {
                console.warn('Geocoding failed for new job address', e);
            }
        }

        const { error } = await supabase.from('jobs').insert([{
            name: newJobName.trim(),
            address: newJobAddress.trim() || null,
            location_lat: lat,
            location_lng: lng,
            status: 'active'
        }]);

        if (error) {
            Alert.alert('Error', error.message);
        } else {
            setModalVisible(false);
            setNewJobName('');
            setNewJobAddress('');
            setNewJobCoords({ lat: null, lng: null });
            fetchJobs();
        }
        setSaving(false);
    }

    async function deleteJob(id: string, name: string) {
        Alert.alert(
            'Delete Job',
            `Are you sure you want to delete "${name}"? This will mark it as inactive.`,
            [
                { text: 'Cancel', style: 'cancel' },
                {
                    text: 'Delete',
                    style: 'destructive',
                    onPress: async () => {
                        const { error } = await supabase
                            .from('jobs')
                            .update({ status: 'inactive' })
                            .eq('id', id);

                        if (error) Alert.alert('Error', error.message);
                        else fetchJobs();
                    }
                }
            ]
        );
    }

    const renderItem = ({ item }: { item: any }) => (
        <View style={styles.cardContainer}>
            <TouchableOpacity
                style={styles.card}
                onPress={() => router.push(`/(tabs)/manager/jobs/${item.id}`)}
            >
                <View style={{ flex: 1 }}>
                    <Text style={styles.jobName}>{item.name}</Text>
                    {item.address && <Text style={styles.address}>{item.address}</Text>}
                    {!item.address && <Text style={styles.noAddress}>No address set</Text>}
                </View>
                <IconSymbol name="chevron.right" size={20} color="#9ca3af" />
            </TouchableOpacity>
            <TouchableOpacity
                onPress={() => deleteJob(item.id, item.name)}
                style={styles.deleteBtn}
            >
                <IconSymbol name="trash.fill" size={18} color="#ef4444" />
            </TouchableOpacity>
        </View>
    );

    return (
        <View style={[styles.container, { paddingTop: insets.top }]}>
            <View style={styles.header}>
                <View style={{ flexDirection: 'row', alignItems: 'center', flex: 1 }}>
                    <TouchableOpacity onPress={() => router.back()} style={{ marginRight: 15 }}>
                        <IconSymbol name="chevron.left" size={28} color="#2563eb" />
                    </TouchableOpacity>
                    <Text style={styles.headerTitle}>Manage Jobs</Text>
                </View>
                <TouchableOpacity
                    style={styles.addBtn}
                    onPress={() => setModalVisible(true)}
                >
                    <IconSymbol name="plus" size={24} color="white" />
                </TouchableOpacity>
            </View>

            {loading ? (
                <ActivityIndicator size="large" color="#2563eb" style={{ marginTop: 20 }} />
            ) : (
                <FlatList
                    data={jobs}
                    keyExtractor={item => item.id}
                    renderItem={renderItem}
                    contentContainerStyle={{ padding: 16 }}
                />
            )}

            <Modal
                visible={modalVisible}
                animationType="slide"
                transparent={true}
                onRequestClose={() => setModalVisible(false)}
            >
                <View style={styles.modalOverlay}>
                    <View style={styles.modalContent}>
                        <Text style={styles.modalTitle}>Add New Job</Text>

                        <Text style={styles.label}>Job Name</Text>
                        <TextInput
                            style={styles.input}
                            value={newJobName}
                            onChangeText={setNewJobName}
                            placeholder="e.g. Smith Residence"
                        />

                        <Text style={styles.label}>Address (Search to autocomplete)</Text>
                        <AddressAutocomplete
                            value={newJobAddress}
                            onSelect={(addr, lat, lng) => {
                                setNewJobAddress(addr);
                                setNewJobCoords({ lat, lng });
                            }}
                            placeholder="Start typing job address..."
                        />

                        <View style={styles.modalActions}>
                            <TouchableOpacity
                                style={styles.cancelBtn}
                                onPress={() => setModalVisible(false)}
                            >
                                <Text style={styles.cancelBtnText}>Cancel</Text>
                            </TouchableOpacity>
                            <TouchableOpacity
                                style={styles.saveBtn}
                                onPress={addJob}
                                disabled={saving}
                            >
                                {saving ? <ActivityIndicator color="white" /> : <Text style={styles.saveBtnText}>Save Job</Text>}
                            </TouchableOpacity>
                        </View>
                    </View>
                </View>
            </Modal>
        </View>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: '#f3f4f6',
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 16,
        paddingTop: 15,
        paddingBottom: 15,
        backgroundColor: 'white',
        borderBottomWidth: 1,
        borderBottomColor: '#e5e7eb'
    },
    headerTitle: {
        fontSize: 22,
        fontWeight: 'bold',
        color: '#1f2937'
    },
    addBtn: {
        backgroundColor: '#2563eb',
        width: 40,
        height: 40,
        borderRadius: 20,
        alignItems: 'center',
        justifyContent: 'center',
        shadowColor: '#2563eb',
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.3,
        shadowRadius: 4,
        elevation: 4
    },
    cardContainer: {
        flexDirection: 'row',
        alignItems: 'center',
        marginBottom: 10,
    },
    card: {
        flex: 1,
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        backgroundColor: 'white',
        padding: 16,
        borderRadius: 12,
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 1 },
        shadowOpacity: 0.05,
        shadowRadius: 2,
        elevation: 2
    },
    deleteBtn: {
        padding: 12,
        marginLeft: 10,
        backgroundColor: '#fee2e2',
        borderRadius: 10,
        alignItems: 'center',
        justifyContent: 'center'
    },
    jobName: {
        fontSize: 16,
        fontWeight: '600',
        color: '#1f2937',
        marginBottom: 4
    },
    address: {
        fontSize: 14,
        color: '#4b5563'
    },
    noAddress: {
        fontSize: 14,
        color: '#9ca3af',
        fontStyle: 'italic'
    },
    // Modal
    modalOverlay: {
        flex: 1,
        backgroundColor: 'rgba(0,0,0,0.5)',
        justifyContent: 'center',
        padding: 20
    },
    modalContent: {
        backgroundColor: 'white',
        borderRadius: 16,
        padding: 24,
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.2,
        shadowRadius: 8,
        elevation: 10
    },
    modalTitle: {
        fontSize: 20,
        fontWeight: 'bold',
        marginBottom: 20,
        textAlign: 'center',
        color: '#111827'
    },
    label: {
        fontSize: 14,
        fontWeight: '600',
        color: '#374151',
        marginBottom: 6,
        marginTop: 12
    },
    input: {
        backgroundColor: '#f9fafb',
        borderWidth: 1,
        borderColor: '#d1d5db',
        borderRadius: 8,
        padding: 12,
        fontSize: 16
    },
    modalActions: {
        flexDirection: 'row',
        marginTop: 24,
        gap: 12
    },
    cancelBtn: {
        flex: 1,
        padding: 14,
        borderRadius: 8,
        backgroundColor: '#f3f4f6',
        alignItems: 'center'
    },
    cancelBtnText: {
        color: '#4b5563',
        fontWeight: '600',
        fontSize: 16
    },
    saveBtn: {
        flex: 1,
        padding: 14,
        borderRadius: 8,
        backgroundColor: '#2563eb',
        alignItems: 'center'
    },
    saveBtnText: {
        color: 'white',
        fontWeight: 'bold',
        fontSize: 16
    }
});
