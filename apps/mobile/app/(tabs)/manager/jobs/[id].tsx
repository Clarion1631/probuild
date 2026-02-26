import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, TextInput, TouchableOpacity, Alert, ActivityIndicator, KeyboardAvoidingView, Platform } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { supabase } from '@/lib/supabase';
import { IconSymbol } from '@/components/ui/icon-symbol';
import * as Location from 'expo-location';
import AddressAutocomplete from '@/components/AddressAutocomplete';

export default function JobDetailScreen() {
    const { id } = useLocalSearchParams();
    const router = useRouter();

    const [job, setJob] = useState<any>(null);
    const [phases, setPhases] = useState<any[]>([]);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);

    // Edit Fields
    const [address, setAddress] = useState('');
    const [selectedCoords, setSelectedCoords] = useState<{ lat: number | null, lng: number | null }>({ lat: null, lng: null });
    const [radius, setRadius] = useState('100');
    const [csvText, setCsvText] = useState('');
    const [showImport, setShowImport] = useState(false);

    useEffect(() => {
        if (id) fetchJobDetails();
    }, [id]);

    async function fetchJobDetails() {
        setLoading(true);
        // Fetch Job
        const { data: jobData, error: jobError } = await supabase
            .from('jobs')
            .select('*')
            .eq('id', id)
            .single();

        if (jobError) {
            Alert.alert('Error', 'Failed to load job.');
            router.back();
            return;
        }

        setJob(jobData);
        setAddress(jobData.address || '');
        setSelectedCoords({ lat: jobData.location_lat, lng: jobData.location_lng });
        setRadius(jobData.radius_meters ? String(jobData.radius_meters) : '100');

        // Fetch Phases
        const { data: phasesData } = await supabase
            .from('job_phases')
            .select('*')
            .eq('job_id', id)
            .order('cost_code', { ascending: true }); // Order by cost code usually better

        if (phasesData) setPhases(phasesData);
        setLoading(false);
    }

    async function saveAddress() {
        setSaving(true);

        let lat = selectedCoords.lat;
        let lng = selectedCoords.lng;

        // Fallback geocoding if coords are missing but address provided (user might have typed without selecting)
        if (!lat && address.trim()) {
            try {
                const geo = await Location.geocodeAsync(address.trim());
                if (geo && geo.length > 0) {
                    lat = geo[0].latitude;
                    lng = geo[0].longitude;
                }
            } catch (e) {
                console.warn('Geocoding failed for job address', e);
            }
        }

        const { error: updateError } = await supabase
            .from('jobs')
            .update({
                address: address.trim() || null,
                radius_meters: parseInt(radius) || 100,
                location_lat: lat,
                location_lng: lng
            })
            .eq('id', id);

        if (updateError) Alert.alert('Error', updateError.message);
        else Alert.alert('Success', 'Address updated!');
        setSaving(false);
        fetchJobDetails();
    }

    async function importPhases() {
        if (!csvText.trim()) {
            Alert.alert('Empty', 'Please paste phase data first.');
            return;
        }

        setSaving(true);
        const lines = csvText.split('\n');
        const newPhases = [];

        for (const line of lines) {
            const parts = line.split(',');
            const name = parts[0]?.trim();
            if (!name) continue;

            const cost_code = parts[1]?.trim() || '00-000';
            const budget_hours = parseFloat(parts[2]?.trim() || '0');

            newPhases.push({
                job_id: id,
                name,
                cost_code,
                budget_hours
            });
        }

        if (newPhases.length === 0) {
            Alert.alert('Error', 'No valid phases parsed.');
            setSaving(false);
            return;
        }

        const { error } = await supabase.from('job_phases').insert(newPhases);

        if (error) {
            Alert.alert('Error', error.message);
        } else {
            Alert.alert('Success', `Imported ${newPhases.length} phases.`);
            setCsvText('');
            setShowImport(false);
            fetchJobDetails();
        }
        setSaving(false);
    }

    if (loading) {
        return (
            <View style={styles.loadingContainer}>
                <ActivityIndicator size="large" color="#2563eb" />
            </View>
        );
    }

    return (
        <KeyboardAvoidingView
            behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
            style={styles.container}
        >
            <View style={styles.header}>
                <TouchableOpacity onPress={() => router.back()} style={{ marginRight: 15 }}>
                    <IconSymbol name="chevron.left" size={28} color="#2563eb" />
                </TouchableOpacity>
                <Text style={styles.headerTitle} numberOfLines={1}>{job.name}</Text>
            </View>

            <ScrollView contentContainerStyle={{ padding: 16 }}>

                <View style={styles.card}>
                    <Text style={styles.sectionTitle}>Job Settings</Text>

                    <Text style={styles.label}>Address (Search to autocomplete)</Text>
                    <AddressAutocomplete
                        value={address}
                        onSelect={(addr, lat, lng) => {
                            setAddress(addr);
                            setSelectedCoords({ lat, lng });
                        }}
                        placeholder="Search for job address..."
                    />

                    <Text style={styles.label}>Geofence Radius (meters)</Text>
                    <TextInput
                        style={styles.input}
                        value={radius}
                        onChangeText={setRadius}
                        keyboardType="numeric"
                        placeholder="100"
                        placeholderTextColor="#9ca3af"
                    />

                    <TouchableOpacity
                        style={[styles.button, saving && styles.buttonDisabled]}
                        onPress={saveAddress}
                        disabled={saving}
                    >
                        <Text style={styles.buttonText}>{saving ? 'Saving...' : 'Save Settings'}</Text>
                    </TouchableOpacity>

                    {/* Geofencing Readiness Badge */}
                    <View style={[
                        styles.geoStatusBadge,
                        { backgroundColor: job?.location_lat ? '#ecfdf5' : '#fff7ed' }
                    ]}>
                        <IconSymbol
                            name={job?.location_lat ? "checkmark.circle.fill" : "exclamationmark.triangle.fill"}
                            size={16}
                            color={job?.location_lat ? "#059669" : "#d97706"}
                        />
                        <Text style={[
                            styles.geoStatusText,
                            { color: job?.location_lat ? "#059669" : "#d97706" }
                        ]}>
                            {job?.location_lat
                                ? "Geofencing Active (Ready)"
                                : "Missing Coordinates - Geofencing Disabled"
                            }
                        </Text>
                    </View>
                </View>

                {/* Phases Section */}
                <View style={styles.card}>
                    <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                        <Text style={styles.sectionTitle}>Phases ({phases.length})</Text>
                        <TouchableOpacity onPress={() => setShowImport(!showImport)}>
                            <Text style={{ color: '#2563eb', fontWeight: 'bold' }}>
                                {showImport ? 'Cancel Import' : '+ Import CSV'}
                            </Text>
                        </TouchableOpacity>
                    </View>

                    {showImport && (
                        <View style={styles.importBox}>
                            <Text style={styles.helperText}>Format: Name, Cost Code, Hours</Text>
                            <TextInput
                                style={[styles.input, { height: 100 }]}
                                value={csvText}
                                onChangeText={setCsvText}
                                placeholder="Framing, 06-100, 40&#10;Electrical, 16-100, 20"
                                multiline
                                numberOfLines={4}
                                textAlignVertical="top"
                            />
                            <TouchableOpacity
                                style={[styles.button, { backgroundColor: '#166534' }]}
                                onPress={importPhases}
                                disabled={saving}
                            >
                                <Text style={styles.buttonText}>Import Phases</Text>
                            </TouchableOpacity>
                        </View>
                    )}

                    {phases.map((phase) => (
                        <View key={phase.id} style={styles.phaseRow}>
                            <View style={{ flex: 1 }}>
                                <Text style={styles.phaseName}>{phase.name}</Text>
                                <Text style={styles.phaseCode}>{phase.cost_code}</Text>
                            </View>
                            <Text style={styles.phaseHours}>{phase.budget_hours} hrs</Text>
                        </View>
                    ))}

                    {phases.length === 0 && !showImport && (
                        <Text style={styles.emptyText}>No phases defined.</Text>
                    )}
                </View>

            </ScrollView>
        </KeyboardAvoidingView>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: '#f3f4f6',
        paddingTop: 50
    },
    loadingContainer: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center'
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 16,
        paddingBottom: 15,
        backgroundColor: 'white',
        borderBottomWidth: 1,
        borderBottomColor: '#e5e7eb'
    },
    headerTitle: {
        fontSize: 20,
        fontWeight: 'bold',
        color: '#1f2937',
        flex: 1
    },
    card: {
        backgroundColor: 'white',
        borderRadius: 12,
        padding: 16,
        marginBottom: 16,
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 1 },
        shadowOpacity: 0.05,
        shadowRadius: 2,
        elevation: 2
    },
    sectionTitle: {
        fontSize: 16,
        fontWeight: '600',
        color: '#374151',
        marginBottom: 10
    },
    input: {
        borderWidth: 1,
        borderColor: '#d1d5db',
        borderRadius: 8,
        padding: 12,
        fontSize: 16,
        marginBottom: 10,
        color: '#1f2937'
    },
    button: {
        backgroundColor: '#2563eb',
        padding: 12,
        borderRadius: 8,
        alignItems: 'center'
    },
    buttonDisabled: {
        backgroundColor: '#93c5fd'
    },
    buttonText: {
        color: 'white',
        fontWeight: 'bold',
        fontSize: 16
    },
    importBox: {
        backgroundColor: '#f9fafb',
        padding: 10,
        borderRadius: 8,
        marginBottom: 15,
        borderWidth: 1,
        borderColor: '#e5e7eb'
    },
    helperText: {
        fontSize: 12,
        color: '#6b7280',
        marginBottom: 5
    },
    phaseRow: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        paddingVertical: 10,
        borderBottomWidth: 1,
        borderBottomColor: '#f3f4f6'
    },
    phaseName: {
        fontSize: 16,
        color: '#1f2937',
        fontWeight: '500'
    },
    phaseCode: {
        fontSize: 12,
        color: '#6b7280'
    },
    phaseHours: {
        fontSize: 14,
        fontWeight: 'bold',
        color: '#374151'
    },
    emptyText: {
        textAlign: 'center',
        color: '#9ca3af',
        fontStyle: 'italic',
        marginTop: 10
    },
    label: {
        fontSize: 14,
        fontWeight: '600',
        color: '#374151',
        marginBottom: 5,
        marginTop: 10
    },
    geoStatusBadge: {
        flexDirection: 'row',
        alignItems: 'center',
        padding: 10,
        borderRadius: 8,
        marginTop: 15,
        gap: 8,
        borderWidth: 1,
        borderColor: 'rgba(0,0,0,0.05)'
    },
    geoStatusText: {
        fontSize: 13,
        fontWeight: '600'
    }
});
